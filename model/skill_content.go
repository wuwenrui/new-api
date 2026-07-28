package model

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
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
