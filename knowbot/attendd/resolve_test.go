package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/knowdb"
	"gitlab.com/recoursellm-group/knowdrive-resolve.engine/resolve"
)

// fakeResolveStore answers what /resolve reads: ranked search (recording each call's tag predicate), stats,
// capabilities, the question's embedding and the atoms' stored text vectors. The question embeds to (1,0); atom
// vectors are chosen so each passage's cosine with it is known.
type fakeResolveStore struct {
	mu       sync.Mutex
	searches []string // "mode|tag_query|filter_all_of" per search
	reads    []string
	failEmb  bool
}

func vecB64(v ...float32) string { return knowdb.QueryVectorFromFloats(v, knowdb.SpaceJinaCLIP).B64 }

func (f *fakeResolveStore) server(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		q := r.URL.Query()
		switch {
		case strings.HasSuffix(r.URL.Path, "/search/embed"):
			if f.failEmb {
				http.Error(w, `{"error":"no embed"}`, 403)
				return
			}
			_, _ = fmt.Fprintf(w, `{"vectors":[%q],"dims":2,"space":%q,"encoder":"jina-clip-v2","search_field":"text"}`, vecB64(1, 0), knowdb.SpaceJinaCLIP)
		case strings.HasSuffix(r.URL.Path, "/search"):
			f.mu.Lock()
			f.searches = append(f.searches, q.Get("mode")+"|"+q.Get("tag_query")+"|"+strings.Join(q["filter[all_of][]"], ",")+q.Get("filter"))
			f.mu.Unlock()
			own := `{"id":"11","sequence_index":0,"file_id":"file-a","uri":"knowbot/trials/t1/returns.md","score":0.033,"content_hash":"blake3:aa","tags":["trial:t1"],"text":"You can return any item within 30 days of delivery."},
				{"id":"12","sequence_index":3,"file_id":"file-a","uri":"knowbot/trials/t1/returns.md","score":0.02,"content_hash":"blake3:aa","tags":["trial:t1"],"text":"Refunds go to the original card."}`
			shared := `{"id":"21","sequence_index":1,"file_id":"file-s","uri":"knowbot/samples/s1/faq.md","score":0.03,"content_hash":"blake3:ss","tags":["sample-set:s1","kind:trial-sample"],"text":"Sample: returns within 14 days."}`
			body := own
			if strings.Contains(r.URL.RawQuery, "sample-set") && !strings.Contains(q.Get("tag_query"), "trial:t1") {
				body = shared
			} else if strings.Contains(q.Get("tag_query"), "sample-set") {
				body = own + "," + shared
			}
			_, _ = fmt.Fprintf(w, `{"score_kind":"rrf","atoms":[%s]}`, body)
		case strings.Contains(r.URL.Path, "/atoms"):
			f.mu.Lock()
			f.reads = append(f.reads, r.URL.Path+"?"+q.Get("sequence_min")+"-"+q.Get("sequence_max"))
			f.mu.Unlock()
			// cosines with (1,0): file-a atom 0 -> 0.8, atom 3 -> 0.6; file-s atom 1 -> 0.75
			rows := map[string][]string{
				"file-a": {fmt.Sprintf(`{"id":"11","sequence_index":0,"text_vector":%q}`, vecB64(0.8, 0.6)), fmt.Sprintf(`{"id":"12","sequence_index":3,"text_vector":%q}`, vecB64(0.6, 0.8))},
				"file-s": {fmt.Sprintf(`{"id":"21","sequence_index":1,"text_vector":%q}`, vecB64(0.75, float32(math.Sqrt(1-0.75*0.75))))},
			}
			for fid, rs := range rows {
				if strings.Contains(r.URL.Path, "/files/"+fid+"/") {
					_, _ = fmt.Fprintf(w, `{"data":[%s],"has_more":false}`, strings.Join(rs, ","))
					return
				}
			}
			_, _ = w.Write([]byte(`{"data":[],"has_more":false}`))
		case strings.HasSuffix(r.URL.Path, "/stats"):
			_, _ = w.Write([]byte(`{"totals":{"files":3,"atoms":9,"bytes":900}}`))
		case strings.HasSuffix(r.URL.Path, "/capabilities"):
			_, _ = w.Write([]byte(`{}`))
		default:
			http.Error(w, `{"error":"not found"}`, 404)
		}
	}))
}

func postResolve(t *testing.T, h http.Handler, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/resolve", strings.NewReader(body)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestResolveOneScope(t *testing.T) {
	f := &fakeResolveStore{}
	kd := f.server(t)
	defer kd.Close()
	h := newServer(apiBase(kd.URL), "k", 5*time.Second, false).routes()
	code, out := postResolve(t, h, `{"store":"vs_x","question":"How long do I have to return an item?","scope":{"tags_all":["trial:t1"],"tags_none":["kind:config"]}}`)
	if code != 200 {
		t.Fatalf("HTTP %d %v", code, out)
	}
	spans := out["spans"].([]any)
	if len(spans) != 2 || out["score_kind"] != "rrf" || out["rank_mode"] != "server_hybrid" || out["calls"].(float64) != 1 {
		t.Fatalf("out %v", out)
	}
	s0, s1 := spans[0].(map[string]any), spans[1].(map[string]any)
	if s0["atom_index"].(float64) != 0 || s0["rank"].(float64) != 0 || s1["rank"].(float64) != 1 {
		t.Errorf("order %v", spans)
	}
	// similarity is the cosine (KnowBot's 1 - distance/2), read from the stored vectors
	if s0["similarity"].(float64) != 0.8 || s1["similarity"].(float64) != 0.6 {
		t.Errorf("similarities %v %v", s0["similarity"], s1["similarity"])
	}
	if tags := s0["tags"].([]any); len(tags) != 1 || tags[0] != "trial:t1" {
		t.Errorf("tags %v", tags)
	}
	rc := out["receipt"].(map[string]any)
	if !strings.HasPrefix(rc["digest"].(string), "blake3:") || len(rc["pin_digests"].([]any)) != 1 {
		t.Errorf("receipt %v", rc)
	}
	// one search, hybrid (server-side): mode unset; atoms 0 and 3 of one file share one vector read
	if len(f.searches) != 1 || strings.HasPrefix(f.searches[0], "fts") || strings.HasPrefix(f.searches[0], "vector") {
		t.Errorf("searches %v", f.searches)
	}
	if len(f.reads) != 1 || !strings.HasSuffix(f.reads[0], "?0-3") {
		t.Errorf("vector reads %v", f.reads)
	}
	// determinism: the same call gives the same digest and order
	_, again := postResolve(t, h, `{"store":"vs_x","question":"How long do I have to return an item?","scope":{"tags_all":["trial:t1"],"tags_none":["kind:config"]}}`)
	if again["receipt"].(map[string]any)["digest"] != rc["digest"] {
		t.Error("digest moved between identical calls")
	}
}

func TestResolveScopesFoldIntoOneTagQuery(t *testing.T) {
	f := &fakeResolveStore{}
	kd := f.server(t)
	defer kd.Close()
	h := newServer(apiBase(kd.URL), "k", 5*time.Second, false).routes()
	code, out := postResolve(t, h, `{"store":"vs_x","question":"returns?","scopes":[{"tags_all":["trial:t1"],"tags_none":["kind:config"]},{"tags_all":["sample-set:s1","kind:trial-sample"],"tags_none":["kind:config"]}],"limit":5}`)
	if code != 200 {
		t.Fatalf("HTTP %d %v", code, out)
	}
	want := "(trial:t1,!kind:config)|(sample-set:s1,kind:trial-sample,!kind:config)"
	if out["tag_query"] != want || out["calls"].(float64) != 1 || len(f.searches) != 1 || !strings.Contains(f.searches[0], want) {
		t.Fatalf("tag_query %v calls %v searches %v", out["tag_query"], out["calls"], f.searches)
	}
	if n := len(out["spans"].([]any)); n != 3 {
		t.Errorf("spans %d", n)
	}
}

func TestResolveScopesSplitWhenTooLarge(t *testing.T) {
	f := &fakeResolveStore{}
	kd := f.server(t)
	defer kd.Close()
	h := newServer(apiBase(kd.URL), "k", 5*time.Second, false).routes()
	var none []string
	for i := 0; i < 10; i++ { // 1 + 10 + 2 leaves: over the 12-leaf limit
		none = append(none, fmt.Sprintf(`"tfile:k%d"`, i))
	}
	body := fmt.Sprintf(`{"store":"vs_x","question":"returns?","scopes":[{"tags_all":["trial:t1"],"tags_none":[%s]},{"tags_all":["sample-set:s1","kind:trial-sample"]}]}`, strings.Join(none, ","))
	code, out := postResolve(t, h, body)
	if code != 200 {
		t.Fatalf("HTTP %d %v", code, out)
	}
	if out["calls"].(float64) != 2 || out["tag_query"] != nil || len(f.searches) != 2 {
		t.Fatalf("calls %v searches %v", out["calls"], f.searches)
	}
	spans := out["spans"].([]any)
	if len(spans) != 3 {
		t.Fatalf("spans %v", spans)
	}
	// merged by RRF score, higher first: own atom 0 (0.033), shared atom 1 (0.03), own atom 3 (0.02)
	got := []string{}
	for _, s := range spans {
		m := s.(map[string]any)
		got = append(got, fmt.Sprintf("%s#%v/%v", m["file_id"], m["atom_index"], m["scope"]))
	}
	if strings.Join(got, " ") != "file-a#0/0 file-s#1/1 file-a#3/0" {
		t.Errorf("merge order %v", got)
	}
	if d := out["receipt"].(map[string]any)["digest"].(string); !strings.HasPrefix(d, "sha256:") {
		t.Errorf("merged digest %s", d)
	}
}

func TestResolveFusionAndErrors(t *testing.T) {
	f := &fakeResolveStore{}
	kd := f.server(t)
	defer kd.Close()
	h := newServer(apiBase(kd.URL), "k", 5*time.Second, true).routes()
	code, out := postResolve(t, h, `{"store":"vs_x","question":"returns?","scope":{"tags_all":["trial:t1"]}}`)
	if code != 200 || out["rank_mode"] != "client_rrf" {
		t.Fatalf("HTTP %d %v", code, out)
	}
	if len(f.searches) != 2 || !strings.HasPrefix(f.searches[0], "fts|") || !strings.HasPrefix(f.searches[1], "vector|") {
		t.Errorf("fusion searches %v", f.searches)
	}
	for _, tc := range []struct {
		body string
		code int
	}{{`{`, 400}, {`{"store":"vs_x","question":""}`, 400}, {`{"store":"","question":"q"}`, 400},
		{`{"store":"vs_x","question":"q","tag_query":"a|b","scopes":[{"tags_all":["x"]},{"tags_all":["y"]}]}`, 400}} {
		if c, o := postResolve(t, h, tc.body); c != tc.code {
			t.Errorf("%s: HTTP %d want %d (%v)", tc.body, c, tc.code, o)
		}
	}
	// no similarity, no answer: the caller keeps its own search
	f.failEmb = true
	if c, o := postResolve(t, h, `{"store":"vs_x","question":"returns?","scope":{"tags_all":["trial:t1"]}}`); c != 502 || !strings.Contains(fmt.Sprint(o["error"]), "similarity") {
		t.Errorf("embed refused: HTTP %d %v", c, o)
	}
	// similarity off: spans without it
	if c, o := postResolve(t, h, `{"store":"vs_x","question":"returns?","scope":{"tags_all":["trial:t1"]},"similarity":"off"}`); c != 200 || o["spans"].([]any)[0].(map[string]any)["similarity"] != nil {
		t.Errorf("similarity off: HTTP %d %v", c, o)
	}
}

func TestOrQueryLimits(t *testing.T) {
	a := scopeIn{TagsAll: []string{"trial:t1"}, TagsNone: []string{"kind:config"}}
	if q := orQuery([]scopeIn{a}); q != "" {
		t.Errorf("one scope needs no OR: %q", q)
	}
	if q := orQuery([]scopeIn{a, {TagsAll: []string{"bad tag"}}}); q != "" {
		t.Errorf("a tag with an operator must not be folded: %q", q)
	}
	var many []string
	for i := 0; i < resolve.TagQueryMaxLeaves; i++ {
		many = append(many, fmt.Sprintf("t%d", i))
	}
	if q := orQuery([]scopeIn{a, {TagsAll: many}}); q != "" {
		t.Errorf("over the leaf limit: %q", q)
	}
}
