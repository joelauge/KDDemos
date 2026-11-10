package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// attendCall posts one question to a fresh server over the fake store and returns the decoded response, the search
// modes the fake saw (in order) and /healthz afterwards.
func attendCall(t *testing.T, fusion, section bool) (out map[string]any, modes []string, health map[string]any) {
	t.Helper()
	var seen []string
	var mu sync.Mutex
	inner := fakeKnowDrive(t, &seen, &mu)
	defer inner.Close()
	kd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/search") {
			mu.Lock()
			modes = append(modes, r.URL.Query().Get("mode"))
			mu.Unlock()
		}
		req, _ := http.NewRequest(r.Method, inner.URL+r.URL.RequestURI(), r.Body)
		req.Header = r.Header.Clone()
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		defer res.Body.Close()
		w.Header().Set("content-type", res.Header.Get("content-type"))
		w.WriteHeader(res.StatusCode)
		_, _ = io.Copy(w, res.Body)
	}))
	defer kd.Close()
	s := newServer(apiBase(kd.URL), "test-key", 5*time.Second, fusion)
	s.noSection.Store(!section)
	h := s.routes()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/attend", strings.NewReader(`{"store":"vs_x","question":"How long do I have to return an item?","scope":{"tags_all":["trial:t1"]}}`)))
	if rec.Code != 200 {
		t.Fatalf("attend: HTTP %d %s (calls %v)", rec.Code, rec.Body, seen)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	return out, modes, health
}

func TestFusionSwitch(t *testing.T) {
	for _, tc := range []struct {
		fusion bool
		modes  string
		rank   string
	}{
		{false, "", "server_hybrid"},       // KnowDB's own hybrid: one search, no mode on the wire
		{true, "fts,vector", "client_rrf"}, // the engine's fusion: fts then vector, one after the other
	} {
		out, modes, health := attendCall(t, tc.fusion, false)
		if got := strings.Join(modes, ","); got != tc.modes {
			t.Errorf("fusion=%t: search modes %q, want %q", tc.fusion, got, tc.modes)
		}
		if health["fusion"] != tc.fusion || health["rank_mode"] != tc.rank {
			t.Errorf("fusion=%t: healthz %v", tc.fusion, health)
		}
		sm, _ := out["summary"].(map[string]any)
		if sm == nil || sm["rank_mode"] != tc.rank {
			t.Errorf("fusion=%t: summary %v", tc.fusion, out["summary"])
		}
	}
	for v, want := range map[string]bool{"": false, "off": false, "on": true, " ON ": true, "1": true, "true": true, "nope": false} {
		if fusionOn(v) != want {
			t.Errorf("fusionOn(%q) = %t", v, !want)
		}
	}
}

// Every evidence item names the heads that surfaced it, and the summary counts them; a store that cannot embed (the
// fake has no embed route) turns H-section off, says so in heads_failed, and still answers.
func TestAttributionAndSectionFallback(t *testing.T) {
	out, _, health := attendCall(t, false, true)
	sm, _ := out["summary"].(map[string]any)
	if sm == nil {
		t.Fatalf("no summary: %v", out)
	}
	if failed, _ := sm["heads_failed"].([]any); len(failed) != 1 || failed[0] != "H-section" {
		t.Errorf("heads_failed %v, want [H-section]", sm["heads_failed"])
	}
	if sm["section_available"] != false || health["section"] != false {
		t.Errorf("section still reported available: summary %v healthz %v", sm, health)
	}
	run, _ := sm["heads_run"].([]any)
	if len(run) == 0 {
		t.Errorf("heads_run %v", run)
	}
	ev, _ := out["evidence"].([]any)
	if len(ev) == 0 {
		t.Fatalf("no evidence: %v", out)
	}
	total := 0
	for _, e := range ev {
		via, _ := e.(map[string]any)["via"].([]any)
		if len(via) == 0 {
			t.Errorf("evidence item without via: %v", e)
		}
		total += len(via)
	}
	contributing, _ := sm["heads_contributing"].(map[string]any)
	n := 0
	for _, c := range contributing {
		n += int(c.(float64))
	}
	if n != total || contributing["H-query"] == nil {
		t.Errorf("heads_contributing %v, want counts of every via (%d)", contributing, total)
	}
	if rc, _ := out["receipt"].(map[string]any); rc == nil || rc["bundle_digest"] == "" {
		t.Error("bundle fields lost in the wrapped response")
	}
}
