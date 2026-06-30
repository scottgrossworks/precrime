# directory sources -- DEPLOYMENT DATA (lives in data/sources/, never in skills/).
# Single source of truth for directory scrape sources. Bootstrap by hand; the server
# is the sole writer and appends discoveries. EMPTY in the template -- each
# deployment grows its own list from its VALUE_PROP.
# format: <url> | <label?> | <category?>   (handle channels: bare handle/url per line)
