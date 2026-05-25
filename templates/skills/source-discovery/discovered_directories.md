# {{DEPLOYMENT_NAME}} -- Discovered Directories and Listing Sites
#
# Seed file imported once at startup by `init-wizard.md` Step 1.5 via
# `precrime__pipeline({ action:"import_sources" })`. The Planner then enqueues
# `SCRAPE_SOURCE` Tasks for these URLs; the `url-loop.md` worker handles the
# actual scraping. Do NOT echo new URLs into this file at runtime -- use
# `pipeline.add_sources` instead. Dedup on URL is enforced by import_sources.
#
# One entry per line: URL | type | estimated_clients | discovered_date
# Types: trade_directory, exhibitor_list, association_members,
#        event_listing, venue_directory, vendor_marketplace
# Lines starting with # are comments and will be ignored.
#
# -------------------------
# ENTRIES BELOW THIS LINE
# -------------------------

