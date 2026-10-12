/**
 * Token-name validation regex — shared between the UI (mint form, rename
 * dialog) and the API routes (mint, PATCH /tokens/:id).
 *
 * Format : lowercase kebab-case, no leading/trailing hyphen, no double
 * hyphens. Matches `^[a-z0-9](-?[a-z0-9])*$`.
 *
 * Why shared : `token-row-controls.tsx` (rename) and `mint-form.tsx` (create)
 * both validate client-side ; the mint route + tokens PATCH route validate
 * server-side. Keeping the regex in one spot prevents drift (rule of three).
 */

export const TOKEN_NAME_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;
