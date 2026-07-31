package model

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

const MaxSkillZipBytes = 20 * 1024 * 1024

func ValidateSkillContent(content []byte) (string, error) {
	if len(content) == 0 {
		return "", fmt.Errorf("Skill ZIP 内容无效")
	}
	if len(content) > MaxSkillZipBytes {
		return "", fmt.Errorf("Skill ZIP 超过 20MB")
	}
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", fmt.Errorf("Skill ZIP 内容无效")
	}
	for _, file := range archive.File {
		name := strings.ReplaceAll(file.Name, "\\", "/")
		if strings.HasPrefix(name, "/") {
			return "", fmt.Errorf("Skill ZIP 包含不安全路径")
		}
		for _, part := range strings.Split(name, "/") {
			if part == ".." {
				return "", fmt.Errorf("Skill ZIP 包含不安全路径")
			}
		}
	}
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:]), nil
}

type SkillContentEntry struct {
	Path  string `json:"path"`
	Size  uint64 `json:"size"`
	IsDir bool   `json:"is_dir"`
}

type SkillContentFile struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Size      uint64 `json:"size"`
	Truncated bool   `json:"truncated"`
}

var (
	ErrSkillContentEntryNotFound = errors.New("Skill 文件不存在")
	ErrSkillContentBinary        = errors.New("Skill 文件不是 UTF-8 文本")
)

func ListSkillContentEntries(content []byte) ([]SkillContentEntry, error) {
	archive, err := openSkillContent(content)
	if err != nil {
		return nil, err
	}
	entries := make([]SkillContentEntry, 0, len(archive.File))
	for _, file := range archive.File {
		name, ok := normalizedSkillEntryName(file.Name)
		if !ok {
			return nil, fmt.Errorf("Skill ZIP 包含不安全路径")
		}
		entries = append(entries, SkillContentEntry{
			Path:  name,
			Size:  file.UncompressedSize64,
			IsDir: file.FileInfo().IsDir(),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Path < entries[j].Path
	})
	return entries, nil
}

func ReadSkillContentEntry(content []byte, requestedPath string, maxBytes int) (SkillContentFile, error) {
	if maxBytes <= 0 {
		return SkillContentFile{}, fmt.Errorf("Skill 文件预览上限无效")
	}
	archive, err := openSkillContent(content)
	if err != nil {
		return SkillContentFile{}, err
	}
	requestedPath, ok := normalizedRequestedSkillPath(requestedPath)
	if !ok {
		return SkillContentFile{}, ErrSkillContentEntryNotFound
	}
	for _, file := range archive.File {
		name, safe := normalizedSkillEntryName(file.Name)
		if !safe {
			return SkillContentFile{}, fmt.Errorf("Skill ZIP 包含不安全路径")
		}
		if name != requestedPath || file.FileInfo().IsDir() {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return SkillContentFile{}, fmt.Errorf("读取 Skill 文件失败: %w", err)
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, int64(maxBytes+utf8.UTFMax)))
		closeErr := reader.Close()
		if readErr != nil {
			return SkillContentFile{}, fmt.Errorf("读取 Skill 文件失败: %w", readErr)
		}
		if closeErr != nil {
			return SkillContentFile{}, fmt.Errorf("关闭 Skill 文件失败: %w", closeErr)
		}
		end, valid := utf8PreviewBoundary(data, maxBytes)
		if !valid {
			return SkillContentFile{}, ErrSkillContentBinary
		}
		return SkillContentFile{
			Path:      name,
			Content:   string(data[:end]),
			Size:      file.UncompressedSize64,
			Truncated: uint64(end) < file.UncompressedSize64,
		}, nil
	}
	return SkillContentFile{}, ErrSkillContentEntryNotFound
}

func openSkillContent(content []byte) (*zip.Reader, error) {
	if len(content) == 0 || len(content) > MaxSkillZipBytes {
		return nil, fmt.Errorf("Skill ZIP 内容无效")
	}
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return nil, fmt.Errorf("Skill ZIP 内容无效")
	}
	return archive, nil
}

func normalizedSkillEntryName(name string) (string, bool) {
	name = strings.ReplaceAll(name, "\\", "/")
	if name == "" || strings.HasPrefix(name, "/") {
		return "", false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", false
		}
	}
	return name, true
}

func normalizedRequestedSkillPath(requestedPath string) (string, bool) {
	requestedPath = strings.TrimPrefix(strings.ReplaceAll(requestedPath, "\\", "/"), "/")
	cleaned := path.Clean(requestedPath)
	if requestedPath == "" || cleaned == "." || cleaned != requestedPath || strings.HasPrefix(cleaned, "../") {
		return "", false
	}
	return cleaned, true
}

func utf8PreviewBoundary(data []byte, maxBytes int) (int, bool) {
	end := 0
	for end < len(data) && end < maxBytes {
		_, size := utf8.DecodeRune(data[end:])
		if size == 1 && data[end] >= utf8.RuneSelf {
			return 0, false
		}
		if end+size > maxBytes {
			break
		}
		end += size
	}
	return end, true
}
