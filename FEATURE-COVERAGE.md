# Motus-Touch feature inventory

Reviewed November 12, 2026, against the user's screenshots, the installed Evoto Desktop color/portrait panels and public official support documentation. The layout and branding are independently designed for Motus-Touch.

## What this inventory means

This is a frontend control inventory for a personal, local photo editor. It is not a claim of Evoto engine parity. Buttons, selectors, toggles and slider values for future functions are saved as per-photo draft settings, with a visible control-preview notice and accessible preview labels. They do not run inference or change the photograph. No model downloads, paid integrations, accounts or cloud processing were added.

Eleven basic color/light controls do process pixels. Their algorithms remain browser-based approximations, not RAW processing or Evoto's implementations. The photo library, folders, visibility, persistence, histogram, comparison, undo/redo and JPEG export work now.

## Module coverage

| Module | Included control families | Reference |
|---|---|---|
| Color adjustments | White balance; tone; presence; profile/filter selectors; levels; curves; HSL/B&W controls; grading; selective color; detail; grain; optics; transform; calibration | [Color tools](https://support.evoto.ai/color-adjustment-feature-modules/) |
| Blemish removal | Freckles/acne; moles; shine; under-eyes; glare; nostrils; lips; chin; facial wrinkle zones; body refinement; protection and manual tuning entry points | [Blemishes](https://support.evoto.ai/blemish-removal/) |
| Skin retouching | Facial/body tonal retouching; frequency controls; finish; complexion; tan lines; tone and radiance | [Skin](https://support.evoto.ai/skin-retouching/) |
| Facial reshape | Head pose; face contours; brow, eye, nose, mouth and symmetry controls; left/right fields for selected linked regions | [Reshape](https://support.evoto.ai/facial-reshape/) |
| Expression | Gummy/gentle smile; open/closed smile levels; neutral expression; generation and tuning entries | [Expression](https://support.evoto.ai/facial-expression/) |
| Teeth | Flaw/edge correction; brightness/desaturation; alignment; generated teeth entry | [Teeth](https://support.evoto.ai/teeth/) |
| Eyes | Iris/white brightness; reflection; flare; glare; veins; cleanliness; symmetry; catchlights; iris correction | [Eyes](https://support.evoto.ai/eyes/) |
| Makeup | Definition; existing eye/lip makeup refinements; look slots and individual component settings | [Makeup](https://support.evoto.ai/makeup/) |
| Hair, hands, body | Hair fill/volume/cleanup/color; hand veins; body proportions and background protection entries | [Hair](https://support.evoto.ai/hair/), [hands](https://support.evoto.ai/hands/), [body](https://support.evoto.ai/full-body-reshape/) |
| AI color | Auto balance/exposure; image consistency; looks; reference match; personal-look training entry | [Color overview](https://support.evoto.ai/color-adjustment-feature-modules/) |
| Masks | Person/apparel regions; pet/background; custom brushes/gradients/ranges; selection; refinement; management | [Masks](https://support.evoto.ai/feature-introduction-masking/) |
| Background | Solid cleanup; lighting; banding; enhancement; backdrop type/color/image settings; sky controls | [Backdrop refinement](https://support.evoto.ai/background-adjustments/), [replacement](https://support.evoto.ai/backdrop-changer/), [sky](https://support.evoto.ai/sky-replacement/) |
| Clothing | Fine/coarse wrinkle controls; blemishes; edges; object protection; tuning; specialist repair entries | [Clothing](https://support.evoto.ai/clothing-adjustment/) |
| Pets | Leash and fur entries; eye enhancement; catchlight settings | [Body](https://support.evoto.ai/pet-body/), [eyes](https://support.evoto.ai/pet-eyes/) |
| Crop/rotate | Aspect/size; overlays; portrait framing; straighten/rotation/flip; expand margins | [Crop/rotate overview](https://support.evoto.ai/home/evoto-desktop/), [rotation](https://support.evoto.ai/rotate/) |
| AI Lab | Scene composition; removal; targeted refinements; background repair; restoration; enhancement and batch entries | [AI Lab](https://support.evoto.ai/ai-lab/) |
| Manual tools | Liquify tool selection; brush parameters; freeze mask; spot healing; patch; clone stamp; tuning | [Toolbar](https://support.evoto.ai/tool-bar/) |
| Workflow | Camera connection and capture settings; watched-folder controls; culling options; batch/preset/asset entries | [Desktop overview](https://support.evoto.ai/home/evoto-desktop/), [hot folders](https://support.evoto.ai/auto-import-and-export/), [culling](https://support.evoto.ai/smart-culling/) |

## Boundaries for later development

- The inventory covers the reviewed desktop editing families. It is not a verified exhaustive list of every version, regional release, mobile/video feature, subscription service or cloud ecosystem feature.
- Style slots represent future choices. Evoto's proprietary makeup assets, LUTs, presets, sky packs and trained models are not copied or bundled.
- Some controls use clear Motus-Touch labels rather than identical vendor wording. Several compound operations are represented by entry buttons; their dedicated canvases, detection overlays and advanced parameter panels are future work.
- Curves are represented by channel/mode/parameter controls, not yet an interactive curve graph. Grading has hue/saturation/luminance fields rather than a completed color-wheel engine.
- Crop, masks, healing, liquify, capture and watched folders are draft settings only. Browser folder collections are implemented separately and do not claim operating-system folder access.
- Catalog IDs remain stable so local processing workers can consume settings later. Working color parameters are deliberately separate from planned parameters, preventing accidental effects or claims of successful AI processing.

## Browser verification

Checked desktop and narrow layouts, sample loading, live color changes, numeric entry, preset application, image import, folder creation with photo assignment, folder navigation, movement into folders, hiding/restoring folders and photos, hidden-item filtering, filmstrip collapse, global feature search and IndexedDB recovery after reload. Confirmed that a planned expression setting does not change image output and persists as a draft.

## Interactive control updates — November 13, 2026

Section headings stay visible while scrolling. Facial Reshape is divided into tabs without changing stored control IDs. Visual selectors replace appropriate dropdowns for complexion, texture finishes, smile style, catchlights, hair color and contact styles; an additional iris-color control group was added at the user’s request. The reference images, drawings and iris graphics are illustrative guides, not processed before/after examples.

Section and group eyes are hold-to-compare controls. For connected basic color controls, holding an eye temporarily substitutes defaults for only that group in the preview, then restores the image on release. Stored settings, undo history and exported pixels are unaffected. AI-only groups instead show an explicit unavailable-engine message.
