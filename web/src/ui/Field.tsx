import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  label: string;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  prefix?: ReactNode;
  suffix?: ReactNode;
  size?: "md" | "lg";
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, hideLabel, hint, error, prefix, suffix, size = "md", id, className, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = `${inputId}-hint`;
  const errId = `${inputId}-err`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={["field", `field--${size}`, error ? "field--invalid" : "", className ?? ""].join(" ")}>
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : "field__label"}>
        {label}
      </label>
      <div className="field__control">
        {prefix && <span className="field__affix field__affix--pre">{prefix}</span>}
        <input ref={ref} id={inputId} className="field__input" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
        {suffix && <span className="field__affix field__affix--suf">{suffix}</span>}
      </div>
      {error && (
        <p id={errId} className="field__error" role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>{error}</span>
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
    </div>
  );
});
