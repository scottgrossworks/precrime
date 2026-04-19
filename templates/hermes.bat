@echo off
docker run -it --rm ^
  -e OPENROUTER_API_KEY=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 ^
  -e TAVILY_API_KEY=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 ^
  -v "%CD%:/precrime" ^
  hermes-precrime
