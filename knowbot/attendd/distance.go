package main

// /resolve's similarity, from ONE KnowDB search. The engine's ranked search (GET /v1/vector_stores/{vs}/search, the
// route that carries atom identity) cannot project a hit's vector distance, and its IdentifiedAtom has no slot for
// it; KnowDB's OpenAI-shaped POST /v1/vector_stores/{vs}/search returns "distance" on every hit (2 - 2·cos of unit
// vectors, so KnowBot's similarity 1 - distance/2 is the cosine the floor reads). That route carries no atom id or
// sequence index, so its hits join resolve's spans by (file id, raw text): the same file and the same raw atom text
// is the same atom (two atoms of one file with the same raw text and different distances are left unjoined).
//
// The search runs beside the ranked call (same question, same tag predicate, hybrid, a window at least twice the
// resolve window) so it adds no round trip; a span it does not cover falls back to the cosine of the question's
// embedding and that span's stored vector (similarities() in resolve.go), and so does every span when it fails.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/resolve"
)

const (
	// the distance window: at least twice the resolve window (a fused or merged window can reach deeper than one
	// server-hybrid window), within KnowDB's hybrid limit
	minDistanceWindow = 20
	maxDistanceWindow = 100
	// a hit's distance is reported up to this ceiling (KnowDB's default, 1.1, would drop hits with cos < 0.45)
	distanceCeiling = 2.0
)

type distanceSearcher struct {
	base, key string // base: the REST base with /api (apiBase)
	hc        *http.Client
}

func newDistanceSearcher(base, key string) *distanceSearcher {
	return &distanceSearcher{base: strings.TrimRight(base, "/"), key: key, hc: &http.Client{Timeout: 15 * time.Second}}
}

type distKey struct{ file, text string }

func spanKey(fileID, text string) distKey {
	return distKey{fileID, strings.Join(strings.Fields(text), " ")}
}

// distances holds each (file, text)'s distance; NaN marks a key two hits disagree on.
type distances map[distKey]float64

func distanceWindow(limit int) int { return min(max(2*limit, minDistanceWindow), maxDistanceWindow) }

// distanceBody is the POST body for one pin: its question and tag predicate (tag_query, or the triad as a filter).
func distanceBody(p resolve.Pin) map[string]any {
	b := map[string]any{"query": p.Query, "max_num_results": distanceWindow(p.Limit), "mode": "hybrid", "text": "raw",
		"max_distance": distanceCeiling, "fields": "file_id,text"}
	if p.TagQuery != "" {
		b["tag_query"] = p.TagQuery
	} else if len(p.TagsAll)+len(p.TagsAny)+len(p.TagsNone) > 0 {
		f := map[string][]string{}
		if len(p.TagsAll) > 0 {
			f["all_of"] = p.TagsAll
		}
		if len(p.TagsAny) > 0 {
			f["any_of"] = p.TagsAny
		}
		if len(p.TagsNone) > 0 {
			f["none_of"] = p.TagsNone
		}
		b["filter"] = f
	}
	return b
}

type distanceHit struct {
	FileID   *string  `json:"file_id"`
	Distance *float64 `json:"distance"`
	Content  []struct {
		Text string `json:"text"`
	} `json:"content"`
}

// search runs one POST search per pin, one after the other (KnowDB caps concurrent searches per caller), and indexes
// every hit that carries a file id and a distance. It returns the hits indexed and the hits without a distance (a
// hybrid hit found by full text alone, outside the vector branch's pool, carries none: its span falls back).
func (d *distanceSearcher) search(ctx context.Context, pins []resolve.Pin) (distances, int, int, error) {
	out := distances{}
	seen, without := 0, 0
	for _, p := range pins {
		hits, err := d.post(ctx, p)
		if err != nil {
			return nil, seen, without, err
		}
		for _, h := range hits {
			if h.FileID == nil || *h.FileID == "" || h.Distance == nil {
				without++
				continue
			}
			seen++
			var sb strings.Builder
			for i, c := range h.Content {
				if i > 0 {
					sb.WriteByte('\n')
				}
				sb.WriteString(c.Text)
			}
			k := spanKey(*h.FileID, sb.String())
			if cur, ok := out[k]; ok && !(math.Abs(cur-*h.Distance) < 1e-6) {
				out[k] = math.NaN()
				continue
			}
			out[k] = *h.Distance
		}
	}
	return out, seen, without, nil
}

func (d *distanceSearcher) post(ctx context.Context, p resolve.Pin) ([]distanceHit, error) {
	body, err := json.Marshal(distanceBody(p))
	if err != nil {
		return nil, err
	}
	u := d.base + "/v1/vector_stores/" + url.PathEscape(p.VectorStoreID) + "/search"
	call := func() ([]distanceHit, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("authorization", "Bearer "+d.key)
		res, err := d.hc.Do(req)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
		if err != nil {
			return nil, err
		}
		if res.StatusCode/100 != 2 {
			return nil, &busyError{code: res.StatusCode, body: string(raw)}
		}
		var w struct {
			Data []distanceHit `json:"data"`
		}
		if err := json.Unmarshal(raw, &w); err != nil {
			return nil, fmt.Errorf("distance search: %w", err)
		}
		return w.Data, nil
	}
	hits, err := call()
	for _, wait := range []time.Duration{300 * time.Millisecond, 800 * time.Millisecond, 1500 * time.Millisecond} {
		be, ok := err.(*busyError)
		if !ok || (be.code != 503 && be.code != 429) {
			break
		}
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) < wait {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
		hits, err = call()
	}
	return hits, err
}

type busyError struct {
	code int
	body string
}

func (e *busyError) Error() string {
	b := e.body
	if len(b) > 200 {
		b = b[:200]
	}
	return fmt.Sprintf("distance search: HTTP %d %s", e.code, b)
}

// joinDistances sets the similarity of every span the distance search covered (1 - distance/2, rounded as the cosine
// path rounds) and returns the indices of the spans it did not cover.
func joinDistances(spans []spanOut, ds distances) (missing []int) {
	for i := range spans {
		d, ok := ds[spanKey(spans[i].FileID, spans[i].Text)]
		if !ok || math.IsNaN(d) {
			missing = append(missing, i)
			continue
		}
		sim := round4(1 - d/2)
		spans[i].Similarity = &sim
	}
	return missing
}
