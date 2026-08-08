export function AmbientSigil() {
  return <svg className="ambient-sigil" viewBox="0 0 720 720" aria-hidden="true" focusable="false">
    <g className="sigil-crimson">
      <circle cx="360" cy="360" r="246" />
      <circle cx="360" cy="360" r="184" strokeDasharray="10 18" />
      <path d="M360 64 616 508 104 508 360 64Z" />
      <path d="m360 142 190 328-380 0 190-328Z" />
      <path d="M114 360h492M360 114v492" />
    </g>
    <g className="sigil-gold">
      <rect x="208" y="208" width="304" height="304" transform="rotate(45 360 360)" />
      <circle cx="360" cy="360" r="94" />
      <path d="M360 18v92M360 610v92M18 360h92M610 360h92" />
      <circle cx="360" cy="114" r="8" />
      <circle cx="606" cy="360" r="8" />
      <circle cx="360" cy="606" r="8" />
      <circle cx="114" cy="360" r="8" />
    </g>
  </svg>;
}

export function JarvisMark() {
  return <svg className="jarvis-mark" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
    <circle cx="22" cy="22" r="18" />
    <path d="m22 5 12 29H10L22 5Z" />
    <path d="M22 10v24M10 22h24" />
    <circle className="jarvis-mark-core" cx="22" cy="22" r="3" />
  </svg>;
}
