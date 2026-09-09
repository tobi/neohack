// Shared by page styles, shadow roots and the self-contained error pages.
// Native scrolling keeps keyboard, touch and platform accessibility behavior.
export const scrollbarStyles = `
*, :host {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb, #73816e) transparent;
}
@supports not (scrollbar-width: thin) {
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb, #73816e);
    border: 2px solid transparent;
    border-radius: 8px;
    background-clip: padding-box;
  }
  ::-webkit-scrollbar-thumb:hover { background-color: var(--scrollbar-thumb-hover, #a2b393); }
}
@media (forced-colors: active) {
  *, :host { scrollbar-width: auto; scrollbar-color: auto; }
}
`;
