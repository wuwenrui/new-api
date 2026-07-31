import type { WatermarkPosition, WatermarkSettings } from "./types";

const POSITIONS: Array<{ value: WatermarkPosition; label: string }> = [
  { value: "top-left", label: "左上" },
  { value: "top-center", label: "上中" },
  { value: "top-right", label: "右上" },
  { value: "middle-left", label: "左中" },
  { value: "center", label: "居中" },
  { value: "middle-right", label: "右中" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-center", label: "下中" },
  { value: "bottom-right", label: "右下" },
];

type Props = {
  settings: WatermarkSettings;
  onSettingsChange: (settings: WatermarkSettings) => void;
  logoFile: File | null;
  onLogoFileChange: (file: File | null) => void;
  disabled: boolean;
};

export default function WatermarkControls({
  settings,
  onSettingsChange,
  logoFile,
  onLogoFileChange,
  disabled,
}: Props) {
  const gapPercent = Math.round((settings.gapXPercent + settings.gapYPercent) / 2);
  return (
    <aside className="watermark-controls" aria-label="水印设置">
      <div className="watermark-section-heading">
        <span>02</span>
        <div>
          <p>水印设置</p>
          <small>默认值已是防去除效果最好的组合</small>
        </div>
      </div>

      <div className="watermark-segmented" role="group" aria-label="水印类型">
        <button
          type="button"
          aria-pressed={settings.mode === "text"}
          className={settings.mode === "text" ? "is-active" : ""}
          disabled={disabled}
          onClick={() => onSettingsChange({ ...settings, mode: "text" })}
        >
          文字水印
        </button>
        <button
          type="button"
          aria-pressed={settings.mode === "image"}
          className={settings.mode === "image" ? "is-active" : ""}
          disabled={disabled}
          onClick={() => onSettingsChange({ ...settings, mode: "image" })}
        >
          图片水印
        </button>
      </div>

      {settings.mode === "text" ? (
        <div className="watermark-field-row watermark-field-row--split">
          <label>
            <span>水印文字</span>
            <input
              aria-label="水印文字"
              type="text"
              value={settings.text}
              disabled={disabled}
              maxLength={80}
              placeholder="例如：仅供 XX 案使用"
              onChange={(event) => onSettingsChange({ ...settings, text: event.target.value })}
            />
          </label>
          <label className="watermark-color-field">
            <span>颜色</span>
            <input
              aria-label="水印颜色"
              type="color"
              value={settings.color}
              disabled={disabled}
              onChange={(event) => onSettingsChange({ ...settings, color: event.target.value })}
            />
          </label>
        </div>
      ) : (
        <label className="watermark-logo-upload">
          <span>上传水印图片</span>
          <input
            aria-label="上传水印图片"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            onChange={(event) => onLogoFileChange(event.target.files?.[0] ?? null)}
          />
          <b>{logoFile?.name ?? "选择带透明背景的 Logo"}</b>
        </label>
      )}

      <div className="watermark-segmented" role="group" aria-label="水印布局">
        <button
          type="button"
          aria-pressed={settings.layout === "tile"}
          className={settings.layout === "tile" ? "is-active" : ""}
          disabled={disabled}
          onClick={() => onSettingsChange({ ...settings, layout: "tile" })}
        >
          全图平铺 · 推荐
        </button>
        <button
          type="button"
          aria-pressed={settings.layout === "single"}
          className={settings.layout === "single" ? "is-active" : ""}
          disabled={disabled}
          onClick={() => onSettingsChange({ ...settings, layout: "single" })}
        >
          单点
        </button>
      </div>
      <p className="watermark-hint">
        {settings.layout === "tile"
          ? "斜向铺满整张图，去水印工具无法完整擦除，防盗用效果最好"
          : "只在画面一处出现，容易被裁剪或消除笔去除"}
      </p>

      {settings.layout === "single" && (
        <fieldset className="watermark-position-fieldset" disabled={disabled}>
          <legend>水印位置</legend>
          <div className="watermark-position-grid">
            {POSITIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                aria-pressed={settings.position === value}
                className={settings.position === value ? "is-active" : ""}
                onClick={() => onSettingsChange({ ...settings, position: value })}
              >
                <i aria-hidden />
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <div className="watermark-slider-stack">
        <RangeField
          label="水印大小"
          value={settings.sizePercent}
          min={2}
          max={40}
          suffix="%"
          disabled={disabled}
          onChange={(value) => onSettingsChange({ ...settings, sizePercent: value })}
        />
        <RangeField
          label="深浅"
          value={Math.round(settings.opacity * 100)}
          min={5}
          max={100}
          suffix="%"
          disabled={disabled}
          onChange={(value) => onSettingsChange({ ...settings, opacity: value / 100 })}
        />
        <RangeField
          label="倾斜角度"
          value={settings.rotation}
          min={-60}
          max={60}
          suffix="°"
          disabled={disabled}
          onChange={(value) => onSettingsChange({ ...settings, rotation: value })}
        />
        {settings.layout === "tile" ? (
          <RangeField
            label="间距"
            value={gapPercent}
            min={0}
            max={40}
            suffix="%"
            disabled={disabled}
            onChange={(value) =>
              onSettingsChange({ ...settings, gapXPercent: value, gapYPercent: value })
            }
          />
        ) : (
          <RangeField
            label="边缘距离"
            value={settings.marginPercent}
            min={0}
            max={20}
            suffix="%"
            disabled={disabled}
            onChange={(value) => onSettingsChange({ ...settings, marginPercent: value })}
          />
        )}
      </div>

      <div className={`watermark-shield${settings.invisible ? " is-on" : ""}`}>
        <label className="watermark-shield-toggle">
          <input
            type="checkbox"
            checked={settings.invisible}
            disabled={disabled}
            onChange={(event) => onSettingsChange({ ...settings, invisible: event.target.checked })}
          />
          <span aria-hidden />
          <b>隐形数字指纹</b>
        </label>
        <p>
          导出时把{settings.mode === "text" ? "水印文字" : "保护标识"}
          写进图片像素深处，肉眼看不见。表面水印被人抹掉后，用下方「验证指纹」仍能证明这张图出自你手。
        </p>
      </div>
    </aside>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  suffix,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="watermark-range-field">
      <span>
        {label}
        <b>
          {value}
          {suffix}
        </b>
      </span>
      <input
        aria-label={label}
        type="range"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
