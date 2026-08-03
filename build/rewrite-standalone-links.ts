import type { Plugin } from "vite";

// The header brand, byte-identical to the single line in send/index.html and
// receive/index.html — the inline SVG is what lets the standalone pages keep
// the logo with no external reference. A drift here fails the build (below).
const BRAND_INNER =
  '<svg class="brand-logo" viewBox="0 0 100 100" fill="none">' +
  '<circle cx="50" cy="50" r="28" stroke="currentColor" stroke-width="6" fill="none"/>' +
  '<path d="M50 14V22M50 78V86M14 50H22M78 50H86" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>' +
  '<circle cx="50" cy="50" r="10" fill="currentColor"/>' +
  '</svg>Lumix';

/**
 * A standalone file has no siblings, so links to the other pages are dead ends.
 * Rewrites are exact-match and `required` ones throw when they miss, so editing
 * the markup breaks the build rather than silently shipping broken links.
 */
export function rewriteStandaloneLinks(): Plugin {
  const rules: { from: string; to: string; required: boolean }[] = [
    {
      from: `<a class="brand" href="../">${BRAND_INNER}</a>`,
      to: `<span class="brand">${BRAND_INNER}</span>`,
      required: true,
    },
    {
      from: 'Open <a href="../receive/">Receive</a> on the other device.',
      to: "Open the standalone receiver on the other device.",
      required: false,
    },
    {
      // A single file has no siblings to load a favicon from, and leaving the
      // link in would be the one external reference in a page whose whole point
      // is having none.
      from: '<link rel="icon" href="../lumix_logo.svg" type="image/svg+xml" opacity="1" />',
      to: "",
      required: false,
    },
    {
      from: '<link rel="icon" href="../lumix_logo.svg" type="image/svg+xml" />',
      to: "",
      required: true,
    },
  ];
  return {
    name: "rewrite-standalone-links",
    transformIndexHtml(html) {
      for (const { from, to, required } of rules) {
        if (!html.includes(from)) {
          if (required) throw new Error(`standalone link rewrite missed its target: ${from}`);
          continue;
        }
        html = html.replaceAll(from, to);
      }
      return html;
    },
  };
}
