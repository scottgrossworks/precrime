// promptLoader.js -- shared {placeholder} filler for the adjunct *_PROMPT.json
// files. STANDING RULE (2026-08-08): LLM prompts are NEVER hardcoded in JS --
// each lives in a JSON file in the SAME FOLDER as its consumer ({lines:[...]}
// plus a _comment documenting its placeholders), imported as an object.
//
// Replacement uses a function, not a string: dossier text and JSON blobs can
// contain `$`, and String.replace expands $-patterns ($&, $') in string
// replacements -- a silent prompt-corruption bug. The function form inserts
// values verbatim.
'use strict';

function fillPrompt(lines, map) {
    let text = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
    for (const [key, val] of Object.entries(map)) {
        text = text.replace(new RegExp('\\{' + key + '\\}', 'g'), () => (val == null ? '' : String(val)));
    }
    return text;
}

module.exports = { fillPrompt };
