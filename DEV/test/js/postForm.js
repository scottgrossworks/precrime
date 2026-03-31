(() => {
    const STATE = {
        url: '',
        port: '',
        prompt: '',
        payload: null
    };

    function extractFormData() {
        const url = document.getElementById('url').value.trim();
        const port = document.getElementById('port').value.trim();
        const prompt = document.getElementById('prompt').value.trim();

        // Construct payload for chat/completions endpoint
        const payload = {
            model: "any", // You may want to allow user to specify model
            messages: [
                { role: "user", content: prompt }
            ]
        };

        // Save to STATE
        STATE.url = url;
        STATE.port = port;
        STATE.prompt = prompt;
        STATE.payload = payload;
    }

    function clearStateAndForm() {
        STATE.url = '';
        STATE.port = '';
        STATE.prompt = '';
        STATE.payload = null;
        document.getElementById('postForm').reset();
        document.getElementById('response').textContent = '';
    }

    document.addEventListener('DOMContentLoaded', function() {
        const form = document.getElementById('postForm');
        const clearBtn = document.getElementById('clearBtn');
        const responseDiv = document.getElementById('response');

        clearBtn.addEventListener('click', function() {
            clearStateAndForm();
        });

        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            extractFormData();

            responseDiv.textContent = 'Loading...';

            // Always use /v1/chat/completions endpoint
            let fullUrl = STATE.url;
            if (!/^https?:\/\//.test(fullUrl)) {
                fullUrl = 'http://' + fullUrl;
            }
            // Remove trailing slash if present
            fullUrl = fullUrl.replace(/\/+$/, '');

            // Append port if provided and not already in URL
            try {
                const u = new URL(fullUrl);
                if (!u.port && STATE.port) {
                    u.port = STATE.port;
                    fullUrl = u.origin;
                } else {
                    fullUrl = u.origin;
                }
            } catch {
                // fallback
                if (STATE.port && !fullUrl.includes(':' + STATE.port)) {
                    fullUrl += ':' + STATE.port;
                }
            }

            // Append endpoint
            fullUrl += '/v1/chat/completions';

            try {
                const res = await fetch(fullUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(STATE.payload)
                });
                const text = await res.text();
                responseDiv.textContent = text;
            } catch (err) {
                responseDiv.textContent = 'Error: ' + err;
            }
        });
    });
})();
