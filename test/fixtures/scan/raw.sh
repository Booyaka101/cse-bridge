#!/bin/sh
# Nightly export: pulls the top results for each term into results/.
for term in widgets gadgets; do
  curl -s "https://www.googleapis.com/customsearch/v1?key=$KEY&cx=$CX&q=$term" > "results/$term.json"
done

# The engine's own sites only.
curl -s "https://customsearch.googleapis.com/customsearch/v1/siterestrict?key=$KEY&cx=$CX&q=widgets" > results/site.json
