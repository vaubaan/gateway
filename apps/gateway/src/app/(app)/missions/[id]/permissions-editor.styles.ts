/**
 * The classes of `permissions-editor.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  editor: 'vb-permissions-editor-editor grid gap-4',
  scroll: 'vb-permissions-editor-scroll [overflow-x:auto]',
  table:
    "vb-permissions-editor-table w-full [border-collapse:collapse] text-left [&_caption]:text-left [&_caption]:[padding:16px_0] [&_caption]:font-semibold [&_th]:p-3 [&_th]:border-b [&_th]:border-b-border [&_th]:[vertical-align:top] [&_td]:p-3 [&_td]:border-b [&_td]:border-b-border [&_td]:[vertical-align:top] [&_input[type='number']]:min-w-[5rem] [&_input[type='number']]:max-w-[8rem]",
};

export default styles;
