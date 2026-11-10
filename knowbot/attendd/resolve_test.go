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

// fakeResolveStore answers what /resolve reads: ranked search (recording each call's tag predicate), the POST search
// that carries each hit's distance (recording its body), stats, capabilities, the question's embedding and the atoms'
// stored text vectors. The question embeds to (1,0); atom vectors are chosen so each passage's cosine with it is
// known, and the POST search's distances agree with them (distance = 2 - 2·cos).
type fakeResolveStore struct {
	mu       sync.Mutex
	searches []string // "mode|tag_query|filter_all_of" per ranked search
	posts    []map[string]any
	reads    []string
	embeds   int
	failEmb  bool
	failPost bool
	// omit leaves these "file#seq" atoms out of the POST search (the distance window missed them); noDist returns
	// them without a distance (a full-text-only hybrid hit)
	omit, noDist map[string]bool
}

// distanceHits is the POST search's reply: the OpenAI-shaped hits, with no atom id or sequence index.
func (f *fakeResolveStore) distanceHits(body map[string]any) string {
	type atom struct {
		key, file, text string
		dist            float64
	}
	own := []atom{{"file-a#0", "file-a", "You can return any item within 30 days of delivery.", 0.4}, {"file-a#3", "file-a", "Refunds go to the original card.", 0.8}}
	shared := []atom{{"file-s#1", "file-s", "Sample: returns within 14 days.", 0.5}}
	var as []atom
	tq, _ := body["tag_query"].(string)
	filter := fmt.Sprint(body["filter"])
	switch {
	case strings.Contains(tq, "sample-set") && strings.Contains(tq, "trial:t1"):
		as = append(own, shared...)
	case strings.Contains(filter, "sample-set"):
		as = shared
	default:
		as = own
	}
	var out []string
	for _, a := range as {
		if f.omit[a.key] {
			continue
		}
		if f.noDist[a.key] {
			out = append(out, fmt.Sprintf(`{"file_id":%q,"filename":"x.md","score":0.01,"content":[{"type":"text","text":%q}],"fts_rank":1}`, a.file, a.text))
			continue
		}
		out = append(out, fmt.Sprintf(`{"file_id":%q,"filename":"x.md","score":0.03,"attributes":{"source_offset":0},"content":[{"type":"text","text":%q}],"distance":%v}`, a.file, a.text, a.dist))
	}
	return `{"object":"vector_store.search_results.page","data":[` + strings.Join(out, ",") + `]}`
}

func vecB64(v ...float32) string { return knowdb.QueryVectorFromFloats(v, knowdb.SpaceJinaCLIP).B64 }

func (f *fakeResolveStore) server(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		q := r.URL.Query()
		switch {
		case strings.HasSuffix(r.URL.Path, "/search/embed"):
			f.mu.Lock()
			f.embeds++
			f.mu.Unlock()
			if f.failEmb {
				http.Error(w, `{"error":"no embed"}`, 403)
				return
			}
			_, _ = fmt.Fprintf(w, `{"vectors":[%q],"dims":2,"space":%q,"encoder":"jina-clip-v2","search_field":"text"}`, vecB64(1, 0), knowdb.SpaceJinaCLIP)
		case strings.HasSuffix(r.URL.Path, "/search") && r.Method == "POST":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.posts = append(f.posts, body)
			f.mu.Unlock()
			if f.failPost {
				http.Error(w, `{"error":"boom"}`, 500)
				return
			}
			_, _ = w.Write([]byte(f.distanceHits(body)))
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
	// similarity is KnowBot's 1 - distance/2 (the cosine), from the one POST search's distances
	if s0["similarity"].(float64) != 0.8 || s1["similarity"].(float64) != 0.6 {
		t.Errorf("similarities %v %v", s0["similarity"], s1["similarity"])
	}
	sim := out["similarity"].(map[string]any)
	if sim["source"] != "distance" || sim["fallback"].(float64) != 0 || sim["reads"].(float64) != 0 || f.embeds != 0 {
		t.Errorf("similarity %v embeds %d", sim, f.embeds)
	}
	// the POST search has the ranked call's question and tag predicate, hybrid, a window of at least twice the limit
	if len(f.posts) != 1 {
		t.Fatalf("posts %v", f.posts)
	}
	pb := f.posts[0]
	if pb["query"] != "How long do I have to return an item?" || pb["mode"] != "hybrid" || pb["max_num_results"].(float64) < 40 || pb["text"] != "raw" ||
		fmt.Sprint(pb["filter"]) != "map[all_of:[trial:t1] none_of:[kind:config]]" || pb["tag_query"] != nil {
		t.Errorf("post body %v", pb)
	}
	if tags := s0["tags"].([]any); len(tags) != 1 || tags[0] != "trial:t1" {
		t.Errorf("tags %v", tags)
	}
	rc := out["receipt"].(map[string]any)
	if !strings.HasPrefix(rc["digest"].(string), "blake3:") || len(rc["pin_digests"].([]any)) != 1 {
		t.Errorf("receipt %v", rc)
	}
	// one ranked search, hybrid (server-side): mode unset; no vector reads
	if len(f.searches) != 1 || strings.HasPrefix(f.searches[0], "fts") || strings.HasPrefix(f.searches[0], "vector") {
		t.Errorf("searches %v", f.searches)
	}
	if len(f.reads) != 0 {
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
	// the distance search carries the same tag_query (no filter), and covers all three spans
	if len(f.posts) != 1 || f.posts[0]["tag_query"] != want || f.posts[0]["filter"] != nil || out["similarity"].(map[string]any)["source"] != "distance" {
		t.Errorf("posts %v similarity %v", f.posts, out["similarity"])
	}
	if f.posts[0]["max_num_results"].(float64) != 20 { // limit 5: the window floor
		t.Errorf("window %v", f.posts[0]["max_num_results"])
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
	// one distance search per scope, each with its own filter
	if len(f.posts) != 2 || !strings.Contains(fmt.Sprint(f.posts[0]["filter"]), "trial:t1") || !strings.Contains(fmt.Sprint(f.posts[1]["filter"]), "sample-set:s1") {
		t.Errorf("posts %v", f.posts)
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
	// the distance search failed and the embedding is refused: no similarity, no answer (the caller keeps its own search)
	f.failEmb, f.failPost = true, true
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

func TestResolveDistanceFallbacks(t *testing.T) {
	body := `{"store":"vs_x","question":"How long do I have to return an item?","scope":{"tags_all":["trial:t1"]}}`
	sims := func(out map[string]any) string {
		var got []string
		for _, s := range out["spans"].([]any) {
			m := s.(map[string]any)
			got = append(got, fmt.Sprintf("%s#%v=%v", m["file_id"], m["atom_index"], m["similarity"]))
		}
		return strings.Join(got, " ")
	}
	// one span outside the distance window: only that span's vector is read (one embed, one read of atom 3)
	f := &fakeResolveStore{omit: map[string]bool{"file-a#3": true}}
	kd := f.server(t)
	h := newServer(apiBase(kd.URL), "k", 5*time.Second, false).routes()
	code, out := postResolve(t, h, body)
	if code != 200 || sims(out) != "file-a#0=0.8 file-a#3=0.6" {
		t.Fatalf("HTTP %d %v", code, out)
	}
	sim := out["similarity"].(map[string]any)
	if sim["source"] != "distance+cosine" || sim["fallback"].(float64) != 1 || f.embeds != 1 || len(f.reads) != 1 || !strings.HasSuffix(f.reads[0], "?3-3") {
		t.Errorf("similarity %v embeds %d reads %v", sim, f.embeds, f.reads)
	}
	kd.Close()
	// a hit without a distance (full text only): the question is embedded beside the ranked call, once
	f = &fakeResolveStore{noDist: map[string]bool{"file-a#3": true}}
	kd = f.server(t)
	h = newServer(apiBase(kd.URL), "k", 5*time.Second, false).routes()
	code, out = postResolve(t, h, body)
	if code != 200 || sims(out) != "file-a#0=0.8 file-a#3=0.6" || f.embeds != 1 || len(f.reads) != 1 {
		t.Fatalf("HTTP %d %v embeds %d reads %v", code, out, f.embeds, f.reads)
	}
	if sim := out["similarity"].(map[string]any); sim["hits"].(float64) != 1 || sim["fallback"].(float64) != 1 {
		t.Errorf("similarity %v", sim)
	}
	kd.Close()
	// the distance search failed: every span's vector is read, the answer is the same
	f = &fakeResolveStore{failPost: true}
	kd = f.server(t)
	defer kd.Close()
	h = newServer(apiBase(kd.URL), "k", 5*time.Second, false).routes()
	code, out = postResolve(t, h, body)
	if code != 200 || sims(out) != "file-a#0=0.8 file-a#3=0.6" {
		t.Fatalf("HTTP %d %v", code, out)
	}
	sim = out["similarity"].(map[string]any)
	if sim["source"] != "cosine" || sim["fallback"].(float64) != 2 || !strings.Contains(fmt.Sprint(sim["error"]), "HTTP 500") || len(f.reads) != 1 {
		t.Errorf("similarity %v reads %v", sim, f.reads)
	}
	// similarity off: no distance search at all
	f.failPost = false
	n := len(f.posts)
	if c, _ := postResolve(t, h, `{"store":"vs_x","question":"q","scope":{"tags_all":["trial:t1"]},"similarity":"off"}`); c != 200 || len(f.posts) != n {
		t.Errorf("similarity off searched for distances: HTTP %d posts %d", c, len(f.posts)-n)
	}
}

func TestJoinDistancesAmbiguous(t *testing.T) {
	spans := []spanOut{{FileID: "f", Text: "same  text"}, {FileID: "f", Text: "other"}, {FileID: "g", Text: "same text"}}
	ds := distances{spanKey("f", "same text"): math.NaN(), spanKey("f", "other"): 0.5}
	missing := joinDistances(spans, ds)
	if fmt.Sprint(missing) != "[0 2]" || *spans[1].Similarity != 0.75 || spans[0].Similarity != nil {
		t.Errorf("missing %v spans %+v", missing, spans)
	}
	if distanceWindow(20) != 40 || distanceWindow(6) != 20 || distanceWindow(50) != 100 {
		t.Errorf("windows %d %d %d", distanceWindow(20), distanceWindow(6), distanceWindow(50))
	}
}
