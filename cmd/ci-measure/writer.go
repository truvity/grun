package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Writer stores report artefacts. Local files today; s3:// is reserved.
type Writer interface {
	Put(name string, data []byte) error
	Location() string
}

type localWriter struct{ dir string }

func (w localWriter) Put(name string, data []byte) error {
	if err := os.MkdirAll(w.dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(w.dir, name), data, 0o644)
}

func (w localWriter) Location() string { return w.dir }

// newWriter picks a Writer from the destination: a path, file:///path, or
// s3://bucket/prefix (not implemented yet).
func newWriter(dest string) (Writer, error) {
	switch {
	case strings.HasPrefix(dest, "s3://"):
		return nil, fmt.Errorf("output %q: the s3 writer is not implemented yet (AWS is out of scope for now); use a local directory", dest)
	case strings.HasPrefix(dest, "file://"):
		return localWriter{dir: strings.TrimPrefix(dest, "file://")}, nil
	default:
		return localWriter{dir: dest}, nil
	}
}
