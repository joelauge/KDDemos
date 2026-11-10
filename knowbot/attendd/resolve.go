package main

// POST /resolve: the engine's ranked search (resolve.Engine.Resolve, the same call kd-mcp's `resolve` tool makes in
// ranked mode) WITHOUT the attend heads: one ranked window of passages for a question under a tag scope, each with
// its rank and score, plus the trace digests. KnowBot's own pipeline (relevance floor, refusal rule, line selection,
// citations, proof) runs on the result unchanged, so each span also carries a similarity on the scale KnowBot's floor
// uses: 1 - distance/2, KnowDB's vector distance of the question and the passage (2 - 2·cos of unit vectors, so the
// similarity IS their cosine). A ranked span carries an RRF score, which is not comparable to that floor, so the
// distance comes from one KnowDB POST search run beside the ranked call (distance.go); a span that search does not
// cover gets the cosine of the question's embedding and its stored text vector instead (one embed call, one vector
// read per file cluster). When neither can be read the call fails: KnowBot then keeps its own search.
//
// Scope: one scope (tags_all/tags_any/tags_none), several scopes (OR: a trial's own files and its shared samples),
// or a raw tag_query. Several scopes go out as ONE KnowDB tag_query when every tag is plain and the expression fits
// KnowDB's tag_query limits; otherwise one ranked call per scope, merged by score (direction from the score kind).
// ATTENDD_FUSION=on applies here too (client-side RRF over separate fts and vector searches).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/knowdb"
	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/resolve"
)

const (
	defResolveLimit = 20
	maxResolveLimit = 50
	maxScopes       = 4
	// spans of one file closer than this (in sequence) share one vector read
	vectorClusterGap = 24
)

type resolveIn struct {
	Store    string    `json:"store"`
	Question string    `json:"question"`
	Scope    *scopeIn  `json:"scope"`
	Scopes   []scopeIn `json:"scopes"`
	TagQuery string    `json:"tag_query"`
	Limit    int       `json:"limit"`
	// Similarity "off" skips the cosine read (the spans then carry no similarity); default on.
	Similarity string `json:"similarity"`
}

type spanOut struct {
	FileID      string   `json:"file_id"`
	Path        string   `json:"path"`
	AtomIndex   int      `json:"atom_index"`
	Text        string   `json:"text"`
	ContentHash string   `json:"content_hash"`
	Score       float64  `json:"score"`
	Rank        int      `json:"rank"`
	Tags        []string `json:"tags"`
	Similarity  *float64 `json:"similarity"`
	// Scope is the index of the scope whose call returned the span (0 when the scopes went out as one call).
	Scope int `json:"scope"`
}

type resolveOut struct {
	Spans     []spanOut `json:"spans"`
	ScoreKind string    `json:"score_kind"`
	RankMode  string    `json:"rank_mode"`
	Calls     int       `json:"calls"`
	TagQuery  string    `json:"tag_query,omitempty"`
	Receipt   struct {
		Digest        string   `json:"digest"`
		ResultDigests []string `json:"result_digests"`
		PinDigests    []string `json:"pin_digests"`
	} `json:"receipt"`
	Similarity struct {
		// Source: "distance" (every span from the distance search), "distance+cosine" (some spans fell back to the
		// cosine read), "cosine" (the distance search failed: every span read), or "off".
		Source string `json:"source"`
		// Hits is how many hits the distance search returned; Fallback how many spans it did not cover.
		Hits     int    `json:"hits"`
		Fallback int    `json:"fallback"`
		Encoder  string `json:"encoder,omitempty"`
		Reads    int    `json:"reads"`
		// SearchMs is the distance search's own time (it runs beside the ranked call); Ms is the time /resolve
		// spent on similarity after the ranked call returned.
		SearchMs int64  `json:"search_ms"`
		Ms       int64  `json:"ms"`
		Error    string `json:"error,omitempty"`
	} `json:"similarity"`
	ScopeDropped int   `json:"scope_dropped"`
	Ms           int64 `json:"ms"`
}

// plainTag reports whether a tag can be written into a tag_query unquoted.
func plainTag(t string) bool { return t != "" && !strings.ContainsAny(t, ",|!()* \t\n") }

// scopeQuery writes one scope as a tag_query conjunction; ok false when a tag holds an operator character.
func scopeQuery(s scopeIn) (string, int, bool) {
	var parts []string
	leaves := 0
	for _, t := range s.TagsAll {
		if !plainTag(t) {
			return "", 0, false
		}
		parts = append(parts, t)
		leaves++
	}
	if len(s.TagsAny) > 0 {
		for _, t := range s.TagsAny {
			if !plainTag(t) {
				return "", 0, false
			}
		}
		parts = append(parts, "("+strings.Join(s.TagsAny, "|")+")")
		leaves += len(s.TagsAny)
	}
	for _, t := range s.TagsNone {
		if !plainTag(t) {
			return "", 0, false
		}
		parts = append(parts, "!"+t)
		leaves++
	}
	return strings.Join(parts, ","), leaves, len(parts) > 0
}

// orQuery ORs several scopes into one KnowDB tag_query, or returns "" when that is not possible within the limits
// KnowDB enforces (resolve.TagQueryMax*): the caller then makes one call per scope.
func orQuery(scopes []scopeIn) string {
	if len(scopes) < 2 {
		return ""
	}
	groups := make([]string, 0, len(scopes))
	leaves, depth := 0, 1
	for _, s := range scopes {
		q, n, ok := scopeQuery(s)
		if !ok {
			return ""
		}
		if len(s.TagsAny) > 0 {
			depth = 2
		}
		groups = append(groups, "("+q+")")
		leaves += n
	}
	q := strings.Join(groups, "|")
	if len(q) > resolve.TagQueryMaxBytes || leaves > resolve.TagQueryMaxLeaves || depth > resolve.TagQueryMaxDepth {
		return ""
	}
	return q
}

// pins builds the ranked pins for one request: one per scope, or one in all when the scopes fold into a tag_query.
func (in resolveIn) pins() ([]resolve.Pin, []int, string, error) {
	if strings.TrimSpace(in.Store) == "" {
		return nil, nil, "", errors.New("store is required")
	}
	if strings.TrimSpace(in.Question) == "" {
		return nil, nil, "", errors.New("question is required")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = defResolveLimit
	}
	limit = min(limit, maxResolveLimit)
	base := resolve.Pin{VectorStoreID: in.Store, Query: in.Question, Limit: limit, TextRaw: true, Transport: resolve.TransportREST}
	scopes := in.Scopes
	if len(scopes) == 0 && in.Scope != nil {
		scopes = []scopeIn{*in.Scope}
	}
	if len(scopes) > maxScopes {
		return nil, nil, "", fmt.Errorf("at most %d scopes", maxScopes)
	}
	if tq := strings.TrimSpace(in.TagQuery); tq != "" {
		if len(scopes) > 1 {
			return nil, nil, "", errors.New("tag_query takes at most one scope beside it")
		}
		if len(scopes) == 1 {
			q, _, ok := scopeQuery(scopes[0])
			if !ok {
				return nil, nil, "", errors.New("a scope tag holds a tag_query operator; give it in tag_query itself")
			}
			tq = q + ",(" + tq + ")"
		}
		p := base
		p.TagQuery = tq
		return []resolve.Pin{p}, []int{0}, tq, nil
	}
	if q := orQuery(scopes); q != "" {
		p := base
		p.TagQuery = q
		return []resolve.Pin{p}, []int{0}, q, nil
	}
	if len(scopes) == 0 {
		return []resolve.Pin{base}, []int{0}, "", nil
	}
	out := make([]resolve.Pin, 0, len(scopes))
	idx := make([]int, 0, len(scopes))
	for i, s := range scopes {
		p := base
		p.TagsAll, p.TagsAny, p.TagsNone = s.TagsAll, s.TagsAny, s.TagsNone
		out = append(out, p)
		idx = append(idx, i)
	}
	return out, idx, "", nil
}

// mergeTraces merges one trace per scope into one ranked list: deduped by (file, atom), ordered by score in the
// direction the score kind says (rrf/fts higher, distance lower; unknown: by rank, scope order), then by (file, atom)
// so the order is deterministic, and cut to limit.
func mergeTraces(traces []*resolve.Trace, scopes []int, limit int) ([]spanOut, string, int) {
	kind := ""
	for i, tr := range traces {
		if i == 0 {
			kind = string(tr.ScoreKind)
		} else if string(tr.ScoreKind) != kind {
			kind = "" // mixed: no direction can be assumed
		}
	}
	seen := map[string]bool{}
	var out []spanOut
	dropped := 0
	for i, tr := range traces {
		dropped += tr.ScopeDropped
		for _, sp := range tr.Spans {
			key := fmt.Sprintf("%s#%d", sp.FileID, sp.AtomIndex)
			if seen[key] || strings.TrimSpace(sp.Text) == "" {
				continue
			}
			seen[key] = true
			tags := sp.Tags
			if tags == nil {
				tags = []string{}
			}
			out = append(out, spanOut{FileID: sp.FileID, Path: sp.Path, AtomIndex: sp.AtomIndex, Text: sp.Text, ContentHash: sp.ContentHash,
				Score: sp.Score, Rank: sp.Rank, Tags: tags, Scope: scopes[i]})
		}
	}
	if len(traces) > 1 {
		k := resolve.ScoreKind(kind)
		sort.SliceStable(out, func(a, b int) bool {
			x, y := out[a], out[b]
			if x.Score != y.Score && (k.HigherIsBetter() || k.LowerIsBetter()) {
				return (x.Score > y.Score) == k.HigherIsBetter()
			}
			if !k.HigherIsBetter() && !k.LowerIsBetter() && x.Rank != y.Rank {
				return x.Rank < y.Rank
			}
			if x.FileID != y.FileID {
				return x.FileID < y.FileID
			}
			return x.AtomIndex < y.AtomIndex
		})
	}
	if len(out) > limit {
		out = out[:limit]
	}
	for i := range out {
		out[i].Rank = i
	}
	return out, kind, dropped
}

// similarities sets each span's similarity: the cosine between the question's embedding and the span's stored text
// vector, which is KnowBot's 1 - distance/2 (KnowDB's distance is 2 - 2·cos). One embed call, then one vector read per
// cluster of nearby atoms per file. The fallback for the spans the distance search did not cover.
// pre is the question's embedding when it was already read (nil: read it here).
func (s *server) similarities(ctx context.Context, store, question string, spans []spanOut, pre *questionVec) (encoder string, reads int, err error) {
	if len(spans) == 0 {
		return "", 0, nil
	}
	if pre == nil {
		pre = s.embedQuestion(ctx, question)
	}
	if pre.err != nil {
		return "", 0, pre.err
	}
	qv, enc := pre.qv, pre.enc
	type window struct {
		file    string
		lo, hi  int
		vectors map[int][]float32
		readErr error
	}
	byFile := map[string][]int{}
	var files []string
	for _, sp := range spans {
		if _, ok := byFile[sp.FileID]; !ok {
			files = append(files, sp.FileID)
		}
		byFile[sp.FileID] = append(byFile[sp.FileID], sp.AtomIndex)
	}
	var wins []*window
	for _, f := range files {
		seqs := byFile[f]
		sort.Ints(seqs)
		w := &window{file: f, lo: seqs[0], hi: seqs[0]}
		for _, q := range seqs[1:] {
			if q-w.hi <= vectorClusterGap && q-w.lo < knowdb.HeavyProjectionMaxResults {
				w.hi = q
				continue
			}
			wins = append(wins, w)
			w = &window{file: f, lo: q, hi: q}
		}
		wins = append(wins, w)
	}
	// a few reads at a time: they are atom reads, not searches, but stay gentle on a shared key
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, w := range wins {
		wg.Add(1)
		go func(w *window) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			w.vectors, w.readErr = busy(ctx, func() (map[int][]float32, error) { return s.ranked.ReadTextVectors(ctx, store, w.file, w.lo, w.hi) })
		}(w)
	}
	wg.Wait()
	for _, w := range wins {
		if w.readErr != nil {
			return enc, len(wins), fmt.Errorf("vectors of %s [%d,%d]: %w", w.file, w.lo, w.hi, w.readErr)
		}
	}
	for i := range spans {
		for _, w := range wins {
			if w.file != spans[i].FileID || spans[i].AtomIndex < w.lo || spans[i].AtomIndex > w.hi {
				continue
			}
			v, ok := w.vectors[spans[i].AtomIndex]
			if !ok {
				return enc, len(wins), fmt.Errorf("no text vector for %s atom %d", spans[i].FileID, spans[i].AtomIndex)
			}
			sim := round4(resolve.Cosine(qv[0], v))
			spans[i].Similarity = &sim
		}
	}
	return enc, len(wins), nil
}

// questionVec is the question's embedding (or why it could not be read).
type questionVec struct {
	qv  [][]float32
	enc string
	err error
}

func (s *server) embedQuestion(ctx context.Context, question string) *questionVec {
	qv, enc, err := embedder{s.kc}.Embed(ctx, "", []string{question})
	if err != nil {
		return &questionVec{err: fmt.Errorf("embed: %w", err)}
	}
	if len(qv) != 1 {
		return &questionVec{err: errors.New("embed: no vector")}
	}
	return &questionVec{qv: qv, enc: enc}
}

func round4(x float64) float64 {
	const m = 10000
	if x < 0 {
		return -float64(int64(-x*m+0.5)) / m
	}
	return float64(int64(x*m+0.5)) / m
}

// resolveCall runs the ranked pins one after the other (KnowDB caps concurrent searches per caller) and merges them;
// the distance search for the same pins runs beside them.
func (s *server) resolveCall(ctx context.Context, in resolveIn) (*resolveOut, error) {
	t0 := time.Now()
	pins, scopes, tq, err := in.pins()
	if err != nil {
		return nil, &badRequest{err}
	}
	simOff := strings.EqualFold(strings.TrimSpace(in.Similarity), "off")
	type distResult struct {
		ds   distances
		hits int
		ms   int64
		err  error
		// pre: the question's embedding, read as soon as the distance search shows some span may miss it (a hit
		// without a distance, or a failed search), so the fallback does not wait for it after the ranked call
		pre *questionVec
	}
	dctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var dch chan distResult
	if !simOff {
		dch = make(chan distResult, 1)
		go func() {
			t := time.Now()
			ds, n, without, err := s.dist.search(dctx, pins)
			r := distResult{ds: ds, hits: n, ms: time.Since(t).Milliseconds(), err: err}
			if err != nil || without > 0 {
				r.pre = s.embedQuestion(dctx, in.Question)
			}
			dch <- r
		}()
	}
	traces := make([]*resolve.Trace, 0, len(pins))
	for _, p := range pins {
		tr, err := busyResolver{s.ranked}.Resolve(ctx, p)
		if err != nil {
			return nil, err
		}
		traces = append(traces, tr)
	}
	out := &resolveOut{RankMode: s.rankMode(), Calls: len(pins), TagQuery: tq}
	out.Spans, out.ScoreKind, out.ScopeDropped = mergeTraces(traces, scopes, pins[0].Limit)
	for _, tr := range traces {
		out.Receipt.ResultDigests = append(out.Receipt.ResultDigests, tr.ResultDigest)
		out.Receipt.PinDigests = append(out.Receipt.PinDigests, tr.PinDigest)
	}
	if len(traces) == 1 {
		out.Receipt.Digest = traces[0].ResultDigest
	} else {
		h := sha256.Sum256([]byte(strings.Join(out.Receipt.ResultDigests, "\n")))
		out.Receipt.Digest = "sha256:" + hex.EncodeToString(h[:])
	}
	if simOff {
		out.Similarity.Source = "off"
	} else {
		t1 := time.Now()
		dr := <-dch
		out.Similarity.Hits, out.Similarity.SearchMs = dr.hits, dr.ms
		missing := make([]int, len(out.Spans))
		for i := range missing {
			missing[i] = i
		}
		out.Similarity.Source = "cosine"
		if dr.err != nil {
			out.Similarity.Error = dr.err.Error()
			log.Printf("attendd: resolve distance search failed (%v); reading every span's vector", dr.err)
		} else {
			missing = joinDistances(out.Spans, dr.ds)
			out.Similarity.Source = "distance"
			if len(missing) > 0 {
				out.Similarity.Source = "distance+cosine"
			}
		}
		out.Similarity.Fallback = len(missing)
		if len(missing) > 0 {
			sub := make([]spanOut, len(missing))
			for j, i := range missing {
				sub[j] = out.Spans[i]
			}
			enc, reads, err := s.similarities(ctx, in.Store, in.Question, sub, dr.pre)
			out.Similarity.Encoder, out.Similarity.Reads = enc, reads
			if err != nil {
				return nil, fmt.Errorf("similarity: %w", err)
			}
			for j, i := range missing {
				out.Spans[i].Similarity = sub[j].Similarity
			}
		}
		out.Similarity.Ms = time.Since(t1).Milliseconds()
	}
	out.Ms = time.Since(t0).Milliseconds()
	return out, nil
}

type badRequest struct{ error }

func (s *server) handleResolve(w http.ResponseWriter, req *http.Request) {
	var in resolveIn
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, maxBody)).Decode(&in); err != nil {
		fail(w, 400, "bad json: "+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), s.timeout)
	defer cancel()
	t0 := time.Now()
	out, err := s.resolveCall(ctx, in)
	if err != nil {
		var br *badRequest
		code := 502
		switch {
		case errors.As(err, &br):
			code = 400
		case ctx.Err() != nil:
			code = 504
		case strings.Contains(err.Error(), "is required") || strings.Contains(err.Error(), "empty tag"):
			code = 400
		}
		log.Printf("attendd: resolve store=%s failed after %s: %v", in.Store, time.Since(t0).Round(time.Millisecond), err)
		fail(w, code, err.Error())
		return
	}
	log.Printf("attendd: resolve store=%s spans=%d calls=%d rank=%s in %s", in.Store, len(out.Spans), out.Calls, out.RankMode, time.Since(t0).Round(time.Millisecond))
	writeJSON(w, 200, out)
}
