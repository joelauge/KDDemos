module knowbot/attendd

go 1.26.3

require gitlab.com/recoursellm-group/knowdrive-resolve.engine v0.0.0

require (
	github.com/klauspost/cpuid/v2 v2.0.9 // indirect
	golang.org/x/sync v0.20.0 // indirect
	lukechampine.com/blake3 v1.3.0 // indirect
)

// The engine is private: scripts/fetch-engine.sh downloads the commit in ENGINE_SHA to ../.engine-src (git-ignored).
replace gitlab.com/recoursellm-group/knowdrive-resolve.engine => ../.engine-src
