// Command attendd serves KnowBot's evidence selector over HTTP on the loopback interface: one POST /attend picks the
// passages a bot may quote for one question (a sealed bundle with a status and a receipt), POST /check checks a reader
// reply against a bundle, GET /healthz says it is up. The engine itself is a separate module, fetched at build time
// (scripts/fetch-engine.sh) and never part of this tree.
//
// Settings: ATTENDD_ADDR (default 127.0.0.1:7071), KNOWDRIVE_BASE_URL (default https://knowdrive.ai), KNOWDRIVE_API_KEY,
// ATTENDD_TIMEOUT (default 20s), ATTENDD_SECTION=off (never read neighbouring atoms by vector).
// Question text is never logged.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/knowdb"
	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/resolve"
	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/resolve/attend"
)

// Small-store defaults: a bot's files are a few dozen documents, so one wider window and a few neighbouring sections
// beat several hops.
const (
	defQueryLimit   = 40
	defSectionFiles = 4
	defDepth        = 1
	defChars        = 22000
	defPassages     = 8
	maxBody         = 64 << 10
)

// Control-plane tags KnowBot puts on files: never a topic, so never bound to a question term or counted as a fact.
var controlPrefixes = []string{"trial:", "tfile:", "expires:", "kind:", "sample-set:", "sample:", "sjob:", "bot:", "bucket:", "dir:", "src:", "site:", "page:", "knowbot"}

func isControl(tag string) bool {
	for _, p := range controlPrefixes {
		if strings.HasPrefix(tag, p) {
			return true
		}
	}
	return tag == "questions"
}

type scopeIn struct {
	TagsAll  []string `json:"tags_all"`
	TagsAny  []string `json:"tags_any"`
	TagsNone []string `json:"tags_none"`
}

type attendIn struct {
	Store        string                               `json:"store"`
	Question     string                               `json:"question"`
	Scope        scopeIn                              `json:"scope"`
	Budget       struct{ Passages, Facts, Chars int } `json:"budget"`
	QueryLimit   int                                  `json:"query_limit"`
	SectionFiles int                                  `json:"section_files"`
	PerFileMax   int                                  `json:"per_file_max"`
	Depth        int                                  `json:"depth"`
}

func orDefault(v, d int) int {
	if v == 0 {
		return d
	}
	return v
}

// request maps the wire body onto the engine's request, with the small-store defaults.
func (in attendIn) request() attend.Request {
	return attend.Request{
		Store: in.Store, Question: in.Question, Depth: orDefault(in.Depth, defDepth),
		Budget:       attend.Budget{Passages: orDefault(in.Budget.Passages, defPassages), Facts: in.Budget.Facts, Chars: orDefault(in.Budget.Chars, defChars)},
		Scope:        attend.Scope{TagsAll: in.Scope.TagsAll, TagsAny: in.Scope.TagsAny, TagsNone: in.Scope.TagsNone},
		QueryLimit:   orDefault(in.QueryLimit, defQueryLimit),
		SectionFiles: orDefault(in.SectionFiles, defSectionFiles),
		PerFileMax:   in.PerFileMax,
	}
}

// busy retries a call KnowDrive refused as busy (HTTP 503 search_busy), a few times, within the request's deadline.
func busy[T any](ctx context.Context, call func() (T, error)) (T, error) {
	v, err := call()
	for _, d := range []time.Duration{300 * time.Millisecond, 800 * time.Millisecond, 1500 * time.Millisecond} {
		var se *knowdb.StatusError
		if err == nil || !errors.As(err, &se) || se.Code != 503 || !strings.Contains(se.Body, "search_busy") {
			return v, err
		}
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) < d {
			return v, err
		}
		select {
		case <-ctx.Done():
			return v, err
		case <-time.After(d):
		}
		v, err = call()
	}
	return v, err
}

type busyResolver struct{ e *resolve.Engine }

func (b busyResolver) Resolve(ctx context.Context, pin resolve.Pin) (*resolve.Trace, error) {
	return busy(ctx, func() (*resolve.Trace, error) { return b.e.Resolve(ctx, pin) })
}

type embedder struct{ kc *knowdb.Client }

func (m embedder) Embed(ctx context.Context, _ string, inputs []string) ([][]float32, string, error) {
	r, err := busy(ctx, func() (knowdb.EmbedResult, error) { return m.kc.EmbedQueries(ctx, knowdb.EmbedParams{Inputs: inputs}) })
	if err != nil {
		return nil, "", err
	}
	out := make([][]float32, len(r.Vectors))
	for i, v := range r.Vectors {
		if out[i], err = v.Floats(); err != nil {
			return nil, "", err
		}
	}
	return out, r.Encoder, nil
}

type fileTags struct{ e *resolve.Engine }

func (f fileTags) FileTags(ctx context.Context, vs string, paths []string) (map[string][]string, error) {
	out := map[string][]string{}
	for _, p := range paths {
		ref, err := f.e.FileAtPath(ctx, vs, p)
		if err != nil {
			return nil, err
		}
		if ref != nil {
			out[p] = ref.Tags
		}
	}
	return out, nil
}

// server holds two engines: with H-section (reads neighbouring atoms by vector), and without it, used when the key
// cannot embed or ATTENDD_SECTION=off.
type server struct {
	full, plain *attend.Engine
	timeout     time.Duration
	noSection   atomic.Bool
}

func newServer(base, key string, timeout time.Duration) *server {
	kc := knowdb.New(base, knowdb.WithTokenSource(knowdb.StaticTokenSource(key)))
	ranked := resolve.NewEngine(kc)
	complete := *ranked
	complete.Searcher = resolve.NewEnumerateSearcher(kc)
	plain := &attend.Engine{Ranked: busyResolver{ranked}, Complete: busyResolver{&complete}, Tags: ranked, Exclude: isControl, FileTags: fileTags{ranked}}
	full := *plain
	full.Embed, full.Neighbours = embedder{kc}, ranked
	return &server{full: &full, plain: plain, timeout: timeout}
}

func (s *server) attend(ctx context.Context, r attend.Request) (*attend.Bundle, error) {
	if !s.noSection.Load() {
		b, err := s.full.Attend(ctx, r)
		if err == nil || !strings.Contains(err.Error(), "H-section") || ctx.Err() != nil {
			return b, err
		}
		log.Printf("attendd: neighbouring sections unavailable (%v); continuing without them", err)
		s.noSection.Store(true)
	}
	return s.plain.Attend(ctx, r)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "section": !s.noSection.Load()})
	})
	mux.HandleFunc("POST /attend", func(w http.ResponseWriter, req *http.Request) {
		var in attendIn
		if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, maxBody)).Decode(&in); err != nil {
			fail(w, 400, "bad json: "+err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), s.timeout)
		defer cancel()
		t0 := time.Now()
		b, err := s.attend(ctx, in.request())
		if err != nil {
			log.Printf("attendd: attend store=%s failed after %s: %v", in.Store, time.Since(t0).Round(time.Millisecond), err)
			code := 502
			if ctx.Err() != nil {
				code = 504
			} else if strings.Contains(err.Error(), "is required") || strings.Contains(err.Error(), "empty tag") {
				code = 400
			}
			fail(w, code, err.Error())
			return
		}
		log.Printf("attendd: attend store=%s status=%s evidence=%d in %s", in.Store, b.Status, len(b.Evidence), time.Since(t0).Round(time.Millisecond))
		writeJSON(w, 200, b)
	})
	mux.HandleFunc("POST /check", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			Evidence []attend.ClientItem `json:"evidence"`
			Facts    []attend.ClientFact `json:"facts"`
			Reply    json.RawMessage     `json:"reply"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 4*maxBody)).Decode(&in); err != nil {
			fail(w, 400, "bad json: "+err.Error())
			return
		}
		raw := string(in.Reply)
		var s string
		if json.Unmarshal(in.Reply, &s) == nil {
			raw = s
		}
		r, err := attend.ParseReply(raw)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, attend.CheckReply(in.Evidence, in.Facts, r))
	})
	return mux
}

// apiBase is the KnowDrive REST base the engine expects: the origin plus /api.
func apiBase(u string) string {
	u = strings.TrimRight(u, "/")
	if !strings.HasSuffix(u, "/api") {
		u += "/api"
	}
	return u
}

func main() {
	log.SetFlags(0)
	addr := envOr("ATTENDD_ADDR", "127.0.0.1:7071")
	key := os.Getenv("KNOWDRIVE_API_KEY")
	if key == "" {
		log.Fatal("attendd: KNOWDRIVE_API_KEY is not set")
	}
	timeout, err := time.ParseDuration(envOr("ATTENDD_TIMEOUT", "20s"))
	if err != nil {
		log.Fatalf("attendd: ATTENDD_TIMEOUT: %v", err)
	}
	s := newServer(apiBase(envOr("KNOWDRIVE_BASE_URL", "https://knowdrive.ai")), key, timeout)
	if strings.EqualFold(os.Getenv("ATTENDD_SECTION"), "off") {
		s.noSection.Store(true)
	}
	if !strings.HasPrefix(addr, "127.0.0.1:") && !strings.HasPrefix(addr, "localhost:") && !strings.HasPrefix(addr, "[::1]:") {
		log.Fatalf("attendd: ATTENDD_ADDR %q must be a loopback address", addr)
	}
	log.Printf("attendd: listening on %s", addr)
	srv := &http.Server{Addr: addr, Handler: s.routes(), ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func envOr(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}
