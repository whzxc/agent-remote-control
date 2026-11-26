package core

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"math"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const nativeImageMaxBytes = 1 << 20
const nativeImageMaxInput = 16 << 20
const nativeImageAttachments = "_connectorImageContent"

func nativeImageMIME(data []byte, path string) string {
	switch projectBinaryKind(data, "") {
	case "Png":
		return "image/png"
	case "Jpeg":
		return "image/jpeg"
	case "Gif":
		return "image/gif"
	case "WebP":
		return "image/webp"
	case "Bmp", "Tiff", "Ico":
		return ""
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return ""
	}
}

type preparedNativeImage struct {
	metadata object
	content  object
}

func (image preparedNativeImage) blocks(label string) []any {
	return []any{object{"type": "text", "text": label + ": " + wire(image.metadata)}, image.content}
}

func prepareNativeImage(data []byte, path string, args object) (preparedNativeImage, error) {
	var result preparedNativeImage
	if len(data) > nativeImageMaxInput {
		return result, errors.New("IMAGE_INPUT_TOO_LARGE: limit=16777216")
	}
	mime := nativeImageMIME(data, path)
	if mime == "" {
		return result, errors.New("UNSUPPORTED_IMAGE_FORMAT")
	}
	input := bytes.NewReader(data)
	shape, _, err := image.DecodeConfig(input)
	if err != nil {
		return result, fmt.Errorf("INVALID_IMAGE: %w", err)
	}
	if shape.Width < 1 || shape.Height < 1 || max(shape.Width, shape.Height) > 32768 || int64(shape.Width)*int64(shape.Height) > 64<<20 {
		return result, errors.New("INVALID_IMAGE: Image size exceeds limit")
	}
	input.Reset(data)
	decoded, _, err := image.Decode(input)
	if err != nil {
		return result, fmt.Errorf("INVALID_IMAGE: %w", err)
	}
	original := image.Pt(shape.Width, shape.Height)
	hashOriginal := hash(data)
	pack := func(output []byte, dimensions image.Point, kind string, reencoded bool) preparedNativeImage {
		return preparedNativeImage{
			metadata: object{"path": path, "originalWidth": original.X, "originalHeight": original.Y,
				"width": dimensions.X, "height": dimensions.Y, "originalBytes": len(data), "bytes": len(output),
				"sha256": hashOriginal, "returnedSha256": hash(output), "mimeType": kind, "reencoded": reencoded},
			content: object{"type": "image", "mimeType": kind, "data": base64.StdEncoding.EncodeToString(output)},
		}
	}
	edge := int(max(1, min(4096, uintOr(args["maxEdge"], 1568))))
	if max(original.X, original.Y) <= edge && len(data) <= nativeImageMaxBytes {
		return pack(data, original, mime, false), nil
	}
	if max(original.X, original.Y) > edge {
		decoded = resizeNativeImage(decoded, edge)
	}
	useJPEG := mime == "image/jpeg"
	if mime == "image/webp" {
		if value, ok := decoded.(interface{ Opaque() bool }); ok {
			useJPEG = value.Opaque()
		}
	}
	quality := int(max(1, min(100, uintOr(args["quality"], 80))))
	for {
		var output bytes.Buffer
		kind := "image/png"
		if useJPEG {
			kind = "image/jpeg"
			err = jpeg.Encode(&output, decoded, &jpeg.Options{Quality: quality})
		} else {
			err = png.Encode(&output, decoded)
		}
		if err != nil {
			return result, err
		}
		if len(data) <= nativeImageMaxBytes && max(original.X, original.Y)*10 < edge*11 && output.Len() >= len(data) {
			return pack(data, original, mime, false), nil
		}
		dimensions := decoded.Bounds().Size()
		if output.Len() <= nativeImageMaxBytes {
			return pack(output.Bytes(), dimensions, kind, true), nil
		}
		if useJPEG && quality > 40 {
			quality = max(40, quality-10)
			continue
		}
		largest := max(dimensions.X, dimensions.Y)
		if largest <= 1 {
			return result, errors.New("IMAGE_TOO_LARGE: cannot fit within 1048576 bytes")
		}
		decoded = resizeNativeImage(decoded, max(1, largest*3/4))
	}
}

type imageWeight struct {
	index int
	value float64
}

func nativeImageWeights(source, target int) [][]imageWeight {
	ratio := float64(source) / float64(target)
	scale := max(1, ratio)
	result := make([][]imageWeight, target)
	sinc := func(x float64) float64 {
		if x == 0 {
			return 1
		}
		return math.Sin(math.Pi*x) / (math.Pi * x)
	}
	for i := range target {
		center := (float64(i)+0.5)*ratio - 0.5
		start := max(0, int(math.Ceil(center-3*scale)))
		end := min(source-1, int(math.Floor(center+3*scale)))
		var sum float64
		weights := make([]imageWeight, 0, end-start+1)
		for j := start; j <= end; j++ {
			x := (float64(j) - center) / scale
			weight := sinc(x) * sinc(x/3)
			sum += weight
			weights = append(weights, imageWeight{j, weight})
		}
		for n := range weights {
			weights[n].value /= sum
		}
		result[i] = weights
	}
	return result
}

func resizeNativeImage(source image.Image, edge int) image.Image {
	bounds := source.Bounds()
	size := bounds.Size()
	ratio := float64(edge) / float64(max(size.X, size.Y))
	width := max(1, int(math.Round(float64(size.X)*ratio)))
	height := max(1, int(math.Round(float64(size.Y)*ratio)))
	xWeights := nativeImageWeights(size.X, width)
	yWeights := nativeImageWeights(size.Y, height)
	accumulate := func(sum *[4]float64, c color.NRGBA, weight float64) {
		sum[0] += float64(c.R) * weight
		sum[1] += float64(c.G) * weight
		sum[2] += float64(c.B) * weight
		sum[3] += float64(c.A) * weight
	}
	channel := func(v float64) uint8 { return uint8(math.Round(max(0, min(255, v)))) }
	pixel := func(values [4]float64) color.NRGBA {
		return color.NRGBA{R: channel(values[0]), G: channel(values[1]), B: channel(values[2]), A: channel(values[3])}
	}

	vertical := image.NewNRGBA(image.Rect(0, 0, size.X, height))
	for y, weights := range yWeights {
		for x := range size.X {
			var sum [4]float64
			for _, weight := range weights {
				raw := source.At(bounds.Min.X+x, bounds.Min.Y+weight.index)
				accumulate(&sum, color.NRGBAModel.Convert(raw).(color.NRGBA), weight.value)
			}
			vertical.SetNRGBA(x, y, pixel(sum))
		}
	}
	result := image.NewNRGBA(image.Rect(0, 0, width, height))
	for x, weights := range xWeights {
		for y := range height {
			var sum [4]float64
			for _, weight := range weights {
				accumulate(&sum, vertical.NRGBAAt(weight.index, y), weight.value)
			}
			result.SetNRGBA(x, y, pixel(sum))
		}
	}
	return result
}

func nativeImagePath(path, thread, cwd string) (string, error) {
	if cwd == "" {
		return "", errors.New("INVALID_PATH")
	}
	workspace, err := canonicalProjectPath(cwd)
	if err != nil {
		return "", err
	}
	actual, err := canonicalProjectPath(projectPath(workspace, path))
	if err != nil {
		return "", err
	}
	if projectContains(workspace, actual) {
		return actual, reviewProjectPath(workspace, actual)
	}
	_, home, err := codexInputs()
	if err != nil {
		return "", err
	}
	visuals, err := canonicalProjectPath(filepath.Join(home, "visualizations"))
	if err != nil {
		return "", errors.New("OUTSIDE_THREAD_IMAGE_ROOT")
	}
	return nativeVisualPath(actual, visuals, thread)
}

func nativeVisualPath(actual, root, thread string) (string, error) {
	if !projectContains(root, actual) {
		return "", errors.New("OUTSIDE_THREAD_IMAGE_ROOT")
	}
	relative, err := filepath.Rel(root, actual)
	if err != nil {
		return "", errors.New("OUTSIDE_THREAD_IMAGE_ROOT")
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	if len(parts) < 5 || parts[3] != thread {
		return "", errors.New("OUTSIDE_THREAD_IMAGE_ROOT")
	}
	for i, size := range []int{4, 2, 2} {
		part := parts[i]
		if len(part) != size || strings.ContainsFunc(part, func(r rune) bool { return r < '0' || r > '9' }) {
			return "", errors.New("OUTSIDE_THREAD_IMAGE_ROOT")
		}
	}
	return actual, reviewProjectPath(root, actual)
}

var nativeImageMarkdown = regexp.MustCompile(`!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)`)

func collectNativeImageData(value any, found *[]string) {
	switch value := value.(type) {
	case string:
		if strings.HasPrefix(value, "data:image/") {
			*found = append(*found, value)
		} else if strings.HasPrefix(value, "{") || strings.HasPrefix(value, "[") {
			var decoded any
			if unmarshalJSON([]byte(value), &decoded) == nil {
				collectNativeImageData(decoded, found)
			}
		}
	case object:
		for _, key := range keys(value) {
			collectNativeImageData(value[key], found)
		}
	case []any:
		for _, row := range value {
			collectNativeImageData(row, found)
		}
	}
}

func nativeImageSource(source, thread, cwd string) ([]byte, error) {
	if strings.HasPrefix(source, "data:image/") {
		header, encoded, valid := strings.Cut(source, ",")
		if !valid || !strings.HasSuffix(header, ";base64") || len(encoded) > nativeImageMaxInput*4/3+4 {
			return nil, errors.New("INVALID_IMAGE_DATA_URL")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, errors.New("INVALID_IMAGE_BASE64")
		}
		return data, nil
	}
	path, err := nativeImagePath(source, thread, cwd)
	if err != nil {
		return nil, err
	}
	return projectReadBytes("", path)
}

func nativeImagesFromItems(items []any, thread, cwd string, args object) []any {
	if args["includeImages"] != true {
		return nil
	}
	maximum := max(1, min(8, uintOr(args["maxImages"], 4)))
	blocks := []any{}
	seen := map[string]bool{}
	var count uint64
	for _, item := range items {
		var sources []string
		switch field(item, "type") {
		case "agentMessage":
			for _, match := range nativeImageMarkdown.FindAllStringSubmatch(text(item, "text"), -1) {
				sources = append(sources, nonemptyTaskText(match[1], match[2]))
			}
		case "mcpToolCall", "dynamicToolCall", "computerToolCall", "browserToolCall":
			collectNativeImageData(field(item, "result"), &sources)
			collectNativeImageData(field(item, "contentItems"), &sources)
		}
		for _, source := range slices.Backward(sources) {
			if count == maximum {
				return blocks
			}
			if seen[source] {
				continue
			}
			seen[source] = true
			path := source
			if strings.HasPrefix(source, "data:") {
				path = "embedded screenshot"
			}
			label := "itemId=" + text(item, "id") + " callId=" + text(item, "callId") + " source=" + path
			data, err := nativeImageSource(source, thread, cwd)
			if err == nil {
				var image preparedNativeImage
				image, err = prepareNativeImage(data, path, nil)
				if err == nil {
					blocks = append(blocks, image.blocks(label)...)
					count++
					continue
				}
			}
			blocks = append(blocks, object{"type": "text", "text": label + ": " + err.Error()})
		}
	}
	return blocks
}

func attachNativeImages(value object, blocks []any) {
	if len(blocks) != 0 {
		value[nativeImageAttachments] = blocks
	}
}

func attachCodexItemImages(ctx context.Context, r operationRequest, result object, page any, latest bool) error {
	if r.args["includeImages"] != true {
		return nil
	}
	thread := text(r.args, "threadId")
	metadata, err := readCodexMetadata(ctx, r.service, thread)
	if err != nil {
		return err
	}
	if metadata["id"] != thread {
		return errors.New("native-thread-id-mismatch")
	}
	items := []any{}
	for _, row := range arr(field(page, "data")) {
		items = append(items, field(row, "item"))
	}
	if !latest {
		slices.Reverse(items)
	}
	attachNativeImages(result, nativeImagesFromItems(items, thread, text(metadata, "cwd"), r.args))
	return nil
}

func init() {
	takeControlImages = func(_ string, value object) []any {
		blocks := arr(value[nativeImageAttachments])
		delete(value, nativeImageAttachments)
		return blocks
	}
	prepareProjectImage = func(data []byte, file string, args object) (object, []any, error) {
		result, err := prepareNativeImage(data, file, args)
		if err != nil {
			return nil, nil, err
		}
		return result.metadata, result.blocks(file), nil
	}
}
