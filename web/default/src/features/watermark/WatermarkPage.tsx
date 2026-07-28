import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { buildWatermarkArchive, type ArchiveFailure } from "./archive";
import WatermarkControls from "./WatermarkControls";
import WatermarkPreview, { type WatermarkQueueItem } from "./WatermarkPreview";
import { DEFAULT_WATERMARK_SETTINGS, isSupportedImage, type WatermarkSettings } from "./types";
import "./watermark.css";

export default function WatermarkPage() {
  const [items, setItems] = useState<WatermarkQueueItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [settings, setSettings] = useState<WatermarkSettings>(DEFAULT_WATERMARK_SETTINGS);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [inputErrors, setInputErrors] = useState<string[]>([]);
  const [failures, setFailures] = useState<ArchiveFailure[]>([]);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [resultText, setResultText] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const itemsRef = useRef(items);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.id === currentId) ?? items[0] ?? null,
    [currentId, items],
  );

  const addFiles = useCallback((files: File[]) => {
    const nextErrors: string[] = [];
    const accepted = files.flatMap((file) => {
      if (!isSupportedImage(file)) {
        nextErrors.push(`${file.name}：仅支持 JPG、PNG、WebP`);
        return [];
      }
      return [
        {
          id: `${crypto.randomUUID()}-${file.name}`,
          file,
          previewUrl: URL.createObjectURL(file),
        },
      ];
    });

    setInputErrors(nextErrors);
    setFailures([]);
    setResultText(null);
    if (accepted.length === 0) {
      return;
    }
    setItems((previous) => [...previous, ...accepted]);
    setCurrentId((previous) => previous ?? accepted[0].id);
  }, []);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles([...(event.target.files ?? [])]);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (!processing) {
      addFiles([...event.dataTransfer.files]);
    }
  };

  const removeItem = (id: string) => {
    setItems((previous) => {
      const removed = previous.find((item) => item.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      const remaining = previous.filter((item) => item.id !== id);
      setCurrentId((selected) => (selected === id ? (remaining[0]?.id ?? null) : selected));
      return remaining;
    });
  };

  const generateArchive = async () => {
    if (items.length === 0) return;
    if (settings.mode === "text" && !settings.text.trim()) {
      setInputErrors(["请输入水印文字"]);
      return;
    }
    if (settings.mode === "image" && !logoFile) {
      setInputErrors(["请上传水印图片"]);
      return;
    }

    setProcessing(true);
    setInputErrors([]);
    setFailures([]);
    setResultText(null);
    setProgress({ completed: 0, total: items.length });
    try {
      const result = await buildWatermarkArchive(
        items.map((item) => item.file),
        settings,
        logoFile,
        setProgress,
      );
      setFailures(result.failures);
      setResultText(`成功 ${result.successCount} 张，失败 ${result.failures.length} 张`);
      if (result.zip) {
        const url = URL.createObjectURL(result.zip);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "watermarked-images.zip";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      }
    } catch (reason) {
      setInputErrors([reason instanceof Error ? reason.message : "生成水印图片失败"]);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <main className="watermark-page">
      <header className="watermark-hero">
        <a href="/" className="watermark-brand" aria-label="返回模型站点">
          <span>MODEL</span>SITE
        </a>
        <div>
          <p className="watermark-kicker">PRIVATE · LOCAL · BATCH</p>
          <h1>图片水印工坊</h1>
          <p>原图不上传。一次设置，批量完成。</p>
        </div>
        <div className="watermark-privacy-badge">
          <i aria-hidden />
          仅在本机处理
        </div>
      </header>

      <div className="watermark-workbench">
        <aside className="watermark-queue" aria-label="图片列表">
          <div className="watermark-section-heading">
            <span>01</span>
            <div>
              <p>待处理图片</p>
              <small>{items.length} 张待处理</small>
            </div>
          </div>

          <label
            className={`watermark-dropzone${processing ? " is-disabled" : ""}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <input
              aria-label="添加图片"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={processing}
              onChange={handleFileInput}
            />
            <b>拖入图片</b>
            <span>或点击批量选择</span>
            <small>JPG · PNG · WEBP</small>
          </label>

          <div className="watermark-file-list">
            {items.map((item, index) => (
              <div
                key={item.id}
                className={`watermark-file-item${selectedItem?.id === item.id ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="watermark-file-select"
                  disabled={processing}
                  onClick={() => setCurrentId(item.id)}
                >
                  <img src={item.previewUrl} alt="" />
                  <span>
                    <b>{item.file.name}</b>
                    <small>第 {index + 1} 张 · 待处理</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="watermark-file-remove"
                  aria-label={`移除 ${item.file.name}`}
                  disabled={processing}
                  onClick={() => removeItem(item.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>

        <WatermarkPreview item={selectedItem} settings={settings} logoFile={logoFile} />

        <WatermarkControls
          settings={settings}
          onSettingsChange={setSettings}
          logoFile={logoFile}
          onLogoFileChange={setLogoFile}
          disabled={processing}
        />
      </div>

      <footer className="watermark-export-bar">
        <div className="watermark-status" aria-live="polite">
          <b>{processing ? "正在生成" : "可以开始"}</b>
          <span>
            {progress.total > 0
              ? `处理进度 ${progress.completed}/${progress.total}`
              : "所有图片将使用当前预览参数"}
          </span>
        </div>
        <div className="watermark-messages">
          {inputErrors.map((message) => (
            <p key={message} role="alert">
              {message}
            </p>
          ))}
          {failures.map((failure) => (
            <p key={`${failure.name}-${failure.message}`} role="alert">
              {failure.name}：{failure.message}
            </p>
          ))}
          {resultText && <p className="is-success">{resultText}</p>}
        </div>
        <button
          type="button"
          className="watermark-export-button"
          disabled={processing || items.length === 0}
          onClick={() => void generateArchive()}
        >
          {processing ? "正在处理…" : "生成并下载 ZIP"}
        </button>
      </footer>
    </main>
  );
}
