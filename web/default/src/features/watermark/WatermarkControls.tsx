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
  return (
    <aside className="watermark-controls" aria-label="水印设置">
      <div className="watermark-section-heading">
        <span>02</span>
        <div>
          <p>水印设置</p>
          <small>所有图片使用同一套参数</small>
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
          aria-pressed={settings.layout === "single"}
          className={settings.layout === "single" ? "is-active" : ""}
          disabled={disabled}
          onClick={() => onSettingsChange({ ...settings, layout: "single" })}
        >
          单点
        </button>
        <button
          type="button"
          aria-pressed={settings.layout === "tile"}
          className={settings.layout === "tile" ? "is-active" : ""}
          disabled={disabled}
          onClick={() => onSettingsChange({ ...settings, layout: "tile" })}
        >
          平铺
        </button>
      </div>

      {settings.layout === "single" ? (
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
      ) : (
        <div className="watermark-slider-pair">
          <RangeField
            label="横向间距"
            value={settings.gapXPercent}
            min={0}
            max={40}
            suffix="%"
            disabled={disabled}
            onChange={(value) => onSettingsChange({ ...settings, gapXPercent: value })}
          />
          <RangeField
            label="纵向间距"
            value={settings.gapYPercent}
            min={0}
            max={40}
            suffix="%"
            disabled={disabled}
            onChange={(value) => onSettingsChange({ ...settings, gapYPercent: value })}
          />
        </div>
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
          label="透明度"
          value={Math.round(settings.opacity * 100)}
          min={5}
          max={100}
          suffix="%"
          disabled={disabled}
          onChange={(value) => onSettingsChange({ ...settings, opacity: value / 100 })}
        />
        <RangeField
          label="旋转角度"
          value={settings.rotation}
          min={-180}
          max={180}
          suffix="°"
          disabled={disabled}
          onChange={(value) => onSettingsChange({ ...settings, rotation: value })}
        />
        {settings.layout === "single" && (
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
