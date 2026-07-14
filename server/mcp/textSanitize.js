// Shared text-sanitization primitives. Pure functions, no side effects, safe to
// require from any module (unlike mcp_gmail.js, which starts a server at require time).

// Replace em dash (U+2014), en dash (U+2013), and any double-hyphen-or-longer run
// (the plain-text ersatz em dash, e.g. " -- ") with a comma. A single hyphen
// ("well-known", "2020-2026") is untouched -- only the banned dash forms are hit.
// Collapses any resulting double comma / doubled whitespace from cascading matches.
// STANDING RULE (2026-07-13): outreach-drafter.md's prose "no em/en dash" instruction
// is advisory and the model repeatedly ignored it. This is the procedural backstop --
// applied at the Gmail send/draft boundary AND the DB save boundary so no path can
// carry a banned dash through, regardless of which skill or model wrote the text.
function stripBannedDashes(s) {
    if (!s) return s;
    return String(s)
        .replace(/\s*[–—]\s*/g, ', ')
        .replace(/\s*-{2,}\s*/g, ', ')
        .replace(/,\s*,/g, ',')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

module.exports = { stripBannedDashes };
