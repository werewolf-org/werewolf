const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

// Escapes player-supplied strings (display names in particular) before they are
// interpolated into innerHTML templates. Everything that comes from the server
// snapshot has to go through this, static labels do not.
export function escapeHtml(value: string | null | undefined): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
