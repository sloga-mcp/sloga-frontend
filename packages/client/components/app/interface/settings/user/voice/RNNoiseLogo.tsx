import { styled } from "styled-system/jsx";

/**
 * RNNoise logo, recreated as an inline SVG: the audio-waveform → smooth
 * sine-wave motif with the neural-net "cube" overlay, plus the wordmark.
 *
 * Inline (not an <img>/asset) on purpose — it renders as first-party markup
 * so the desktop shell CSP (slice 6.2b) never has to allow an image origin,
 * and the wordmark uses `currentColor` so it stays legible in both the light
 * and dark settings themes. Shown in Voice Processing to credit the
 * open-source filter behind "Enhanced" noise suppression.
 *
 * To use the exact upstream bitmap instead: drop it at
 * `public/rnnoise/rnnoise-logo.svg` (or .png) and swap the <svg> below for an
 * <img src={`${import.meta.env.BASE_URL}rnnoise/rnnoise-logo.svg`} />.
 */
export function RNNoiseLogo() {
  return (
    <Wrapper>
      <svg
        viewBox="0 0 400 96"
        height="24"
        width="100"
        role="img"
        aria-label="RNNoise"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id="rnnoise-wave"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="150"
            y2="0"
          >
            <stop offset="0" stop-color="#38bdf8" />
            <stop offset="0.5" stop-color="#3b82f6" />
            <stop offset="1" stop-color="#8b5cf6" />
          </linearGradient>
        </defs>

        {/* audio waveform bars (left) */}
        <g stroke="url(#rnnoise-wave)" stroke-width="3" stroke-linecap="round">
          <line x1="8" y1="42" x2="8" y2="54" />
          <line x1="16" y1="36" x2="16" y2="60" />
          <line x1="24" y1="28" x2="24" y2="68" />
          <line x1="32" y1="20" x2="32" y2="76" />
          <line x1="40" y1="26" x2="40" y2="70" />
          <line x1="48" y1="33" x2="48" y2="63" />
          <line x1="56" y1="38" x2="56" y2="58" />
          <line x1="64" y1="42" x2="64" y2="54" />
        </g>

        {/* smooth sine wave sweeping through the mark (drawn behind the net) */}
        <path
          d="M6,48 q 18,-24 36,0 t 36,0 t 36,0 t 36,0"
          fill="none"
          stroke="url(#rnnoise-wave)"
          stroke-width="4"
          stroke-linecap="round"
        />

        {/* neural-net cube edges */}
        <g stroke="#94a3b8" stroke-width="1.5" opacity="0.4">
          <line x1="80" y1="30" x2="114" y2="30" />
          <line x1="114" y1="30" x2="114" y2="64" />
          <line x1="114" y1="64" x2="80" y2="64" />
          <line x1="80" y1="64" x2="80" y2="30" />
          <line x1="94" y1="20" x2="128" y2="20" />
          <line x1="128" y1="20" x2="128" y2="54" />
          <line x1="128" y1="54" x2="94" y2="54" />
          <line x1="94" y1="54" x2="94" y2="20" />
          <line x1="80" y1="30" x2="94" y2="20" />
          <line x1="114" y1="30" x2="128" y2="20" />
          <line x1="114" y1="64" x2="128" y2="54" />
          <line x1="80" y1="64" x2="94" y2="54" />
        </g>

        {/* neural-net nodes */}
        <g>
          <circle cx="80" cy="30" r="4.5" fill="#4338ca" />
          <circle cx="114" cy="30" r="4.5" fill="#7c3aed" />
          <circle cx="114" cy="64" r="4.5" fill="#a855f7" />
          <circle cx="80" cy="64" r="4.5" fill="#6366f1" />
          <circle cx="94" cy="20" r="4.5" fill="#312e81" />
          <circle cx="128" cy="20" r="4.5" fill="#22d3ee" />
          <circle cx="128" cy="54" r="4.5" fill="#14b8a6" />
          <circle cx="94" cy="54" r="4.5" fill="#8b5cf6" />
        </g>

        {/* wordmark */}
        <text
          x="168"
          y="63"
          font-family="inherit"
          font-size="44"
          font-weight="600"
          letter-spacing="-1"
          fill="currentColor"
          opacity="0.85"
        >
          RNNoise
        </text>
      </svg>
    </Wrapper>
  );
}

const Wrapper = styled("span", {
  base: {
    // inline-flex so the logo sits on the same line as the title text; color
    // is inherited (currentColor drives the wordmark) so it matches whatever
    // text color the host row uses.
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    color: "inherit",
  },
});
