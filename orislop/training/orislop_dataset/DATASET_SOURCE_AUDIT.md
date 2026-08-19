# Dataset source audit

Audited 2026-07-15. This is an engineering intake policy, not legal advice.
Every downloaded asset still needs a retained license/provenance record.

## Production candidate sources

- User-owned recordings or directly licensed media are the preferred source.
- Creator-authorized social posts may be retained as reference URLs, but the
  creator must provide a local master or a separate authorized direct file.
  Orislop never treats a social-platform URL as acquisition permission.
- Wikimedia Commons can supply public-domain, CC0, and CC BY video candidates.
  The file description page is the source of truth for license and attribution.
  Orislop does not automatically approve authenticity, consent, or personality
  rights merely because copyright reuse is allowed.
- NASA's current media guidelines explicitly discuss AI training and say NASA
  content is generally not copyrighted in the United States. They also warn
  about third-party material, logos/endorsement, and identifiable-person
  privacy or publicity rights. NASA discoveries therefore stay review-only.
- NARA states that many federal works are public domain, but its holdings are
  not uniformly unrestricted. Only per-item records documented as unrestricted
  may be promoted.
- Pexels and Pixabay are discovery-only unless their operators give Orislop
  written permission covering dataset download, commercial ML training,
  derivative creation, and trained-model distribution. Their public content
  licenses alone are not treated as approval for a bulk training corpus.

## Quarantined sources

- YouTube, TikTok, and Instagram automated search, scraping, and media
  downloading are disabled. Known posts may be stored only as reference URLs;
  approved acquisition must use a separately supplied local master or direct
  non-platform file with a complete rights ledger.
- FaceForensics++, FakeAVCeleb, AV-Deepfake1M, DF40, DFDC, Celeb-DF, and similar
  benchmarks are not automatically production-approved. Dataset EULAs and
  non-commercial terms are separate from permissive licenses on repository
  code.

## Generator intake

- `generator_registry.json` is the current admission registry. Every generated
  sample must retain a generator family, exact checkpoint hash or hosted-model
  version/request ID, a dated terms snapshot, and approved input/output rights
  reviews.
- Wav2Lip research weights are quarantined because the published repository
  identifies them as non-commercial research artifacts.
- Hosted services and open checkpoints such as Runway, Sync Labs, Stable Video
  Diffusion, and DeepFaceLab are conditional. Code licenses do not by themselves
  establish checkpoint, training-data, output, biometric, or performer rights.
- Unknown, mirrored, or unverifiable checkpoints are rejected rather than
  silently entering the production corpus.

## Label and consent gates

- Human visual judgment or an Orislop model prediction cannot be the sole
  ground truth. Genuine samples need provenance records; generated samples need
  generation logs or independently approved source truth.
- Copyright permission is separate from performer permission. Identifiable
  adults require releases, and synthetic face, voice, or audiovisual use must
  be specifically authorized. Identifiable minors and people whose capacity to
  consent is uncertain are excluded from the current production corpus until a
  separately reviewed guardian/capacity policy is implemented.
- Ordinary captions, crops, recompression, filters, screen recording, dubbing,
  and delay remain genuine transformations. Face swaps, reenactment, synthetic
  speech, and generated frames are synthetic/manipulated transformations.
- At least two generator families stay completely held out from training and
  validation. The independent genuine safety corpus and final test set remain
  sealed until architecture, calibration, and thresholds are frozen.

## Discovery snapshot

The 2026-07-15 metadata-only scan produced 300 Wikimedia video candidates
(about 77.3 GiB) and 10 NASA video candidates (about 26.8 GiB). The default
per-file copyright filter accepted 232 Commons records; the remaining 68
Commons records and all NASA records require rights review. All 310 candidates
remain reference-only until a human verifies authenticity labels and any
needed consent or personality-rights clearance. No media from this queue has
been represented as production training data.

## Primary references

- YouTube Terms: https://www.youtube.com/static?template=terms
- YouTube API Services developer policies:
  https://developers.google.com/youtube/terms/developer-policies
- TikTok Research API eligibility:
  https://developers.tiktok.com/products/research-api/
- Meta automated data collection terms:
  https://www.facebook.com/legal/automated_data_collection_terms
- Wikimedia reuse and licensing:
  https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/licenses/en
- Wikimedia API metadata:
  https://www.mediawiki.org/wiki/API:Imageinfo
- NASA media guidelines:
  https://www.nasa.gov/nasa-brand-center/images-and-media/
- NASA Image and Video Library API:
  https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf
- NARA permissions:
  https://www.archives.gov/research/motion-pictures/permissions
- FaceForensics++: https://github.com/ondyari/FaceForensics
- FakeAVCeleb: https://github.com/DASH-Lab/FakeAVCeleb
- AV-Deepfake1M: https://github.com/ControlNet/AV-Deepfake1M
- DF40: https://github.com/YZY-stack/DF40
- Pexels machine-learning and API guidance:
  https://help.pexels.com/hc/en-us/articles/900005880463-What-are-the-Terms-and-Conditions
- Pixabay intellectual-property guidance:
  https://pixabay.com/blog/posts/intellectual-property-explained-441/
- Wav2Lip: https://github.com/Rudrabha/Wav2Lip
- Runway terms: https://runwayml.com/terms-of-use
- Stable Video Diffusion license:
  https://huggingface.co/stabilityai/stable-video-diffusion-img2vid/blob/main/LICENSE.md
