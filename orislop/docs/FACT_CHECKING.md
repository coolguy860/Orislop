# Source-backed fact checking

Orislop checks informational Shorts without adding a third user-facing verdict. Qwen extracts at most two externally verifiable claims, the selected local or cloud bridge retrieves current evidence, and Qwen judges each claim using only the returned source records.

For Google ClaimReview results, Orislop treats the reviewed claim and textual rating as a linked pair: a `False`, `incorrect`, `not true`, or `misleading` rating refutes that reviewed claim and can never be interpreted as support. A deterministic post-check enforces this direction after Qwen runs. Only evidence with material term overlap to the extracted claim can count toward the decision or automatic-skip source threshold.

## Evidence providers

Configure at least one provider with `pnpm fact-check:setup`:

- [Google Fact Check Tools API](https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search) searches published ClaimReview records. It is strongest for claims that professional fact-checkers have already reviewed.
- [Brave Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) retrieves current web results. Orislop retains only government, intergovernmental, academic, established research, and explicitly allowlisted fact-check sources.

For local mode, the provider key is written to `apps/detector-bridge/.env.local`, which is ignored by Git. Cloud deployments store the key in the provider secret manager. Keys remain in the selected inference service and are never sent to the extension or embedded in its package.

## Decision policy

An evidence result is one of `supported`, `contradicted`, `mixed`, or `insufficient`.

Orislop turns a fact check into **Skip** only when all of these are true:

1. The result directly contradicts the claim.
2. Qwen confidence is at least 0.88.
3. At least two independent trusted source domains materially match the claim and specifically support the contradiction. Unrelated or opposite-direction ClaimReview records do not count.

Supported, mixed, insufficient, single-source, provider-error, and timeout results never create a fact-check Skip. They fail open. Synthetic-media and slop decisions remain separate evidence paths.

## User explanations

Every current video can expose **Explain video**, which asks Qwen to summarize only the title, visible caption, and transcript Orislop captured. When the fact checker produced a source-backed contradiction, the Skip cover exposes **Why is this wrong?** instead. That answer is constrained to the captured video text, Orislop decision fields, and retained trusted evidence records; direct source links appear beside it. Transcript and evidence text are treated as untrusted prompt data, and missing context is stated as uncertainty. The explanation is held only in a bounded in-memory cache and never changes the binary Skip/Don't skip decision.

## Privacy

Claim extraction and evidence adjudication run through Qwen in the selected inference environment. When fact checking is configured, the extracted claim text is sent as a search query to the selected provider. Source URLs, titles, snippets, ratings, and the resulting decision are cached in bridge memory; source links may also be stored with local protected-activity records. Feed media, account cookies, browsing credentials, and provider keys are not included in search requests.

The bridge does not fetch arbitrary result pages. This avoids turning source URLs into a server-side request-forgery path. Evidence is limited to provider-returned metadata from HTTPS sources that pass the authority allowlist.

## Limits

Fact checking is evidence-assisted, not a guarantee of truth. Search coverage can be incomplete, source snippets can omit context, professional fact checks can disagree, and new claims may not have reliable sources yet. The conservative automatic-skip threshold is designed to preserve uncertain content.
