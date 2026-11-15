# Motus-Touch

A free, local personal photo studio. Near-black navy and charcoal interface, browser-local photo library, folder collections and a detailed editing-control inventory.

## Open

Double-click `Start Motus-Touch.command` (Windows: `Start Motus-Touch (Windows).bat`), or run `python3 serve.py`. It serves this folder on http://127.0.0.1:4173 with no caching, security headers and cross-origin isolation (lets AI models use several CPU cores), then opens your browser. Opening `index.html` directly from Finder does not work for editing.

No installation, build process or runtime external requests are required. The original project directory remains `forma-local` to preserve the existing local URL.

## Working

- Photo-led opening page with sample preview, recent photos and bottom upload area; folders live in Library.
- Local JPG, PNG, WebP and AVIF import, including drag and drop.
- Create folders, open folder contents, drag one photo or selected photos onto folder cards or sidebar folders; move controls remain available.
- Hide and restore photos or folders. Hidden items collection and Show hidden checkboxes.
- Collapse and restore the filmstrip with its centered arrow or T; the main viewer expands into the released space.
- Browser-local persistence of photos, folders, visibility, light/color settings and preview-control recipes through IndexedDB.
- Eleven basic adjustments: exposure, contrast, brightness, highlights, shadows, whites, blacks, temperature, tint, vibrance and saturation.
- Colored temperature, tint, saturation and hue tracks; editable numeric values; RGB histogram and image RGB sampling.
- Contextual Studio sidebar with Looks and clickable edit History, separate from the Library sidebar.
- Both Studio panels collapse to compact icon rails. Click the selected category again to close it. Header buttons float or dock either panel; drag a floating panel by its heading. Modes, selected sidebar tab and floating positions are remembered.
- Zoom controls sit on the left below the image.
- Nested retouching groups with collapsible child controls that enable when their parent is active.
- Paired L/R controls for bilateral face shape, eyebrows, eye shape/brightness, smile lines, gummy smile, side hair volume and body proportions including hips. Each pair has its own chain button. Linking moves both sides by the same amount, preserves an existing difference, and stops at the shared limits. Values and links are saved per photo and portrait target and participate in undo/redo; these are preview recipes, not image reshaping.
- Editing-category icons have restrained individual color accents.
- Sticky section headers keep collapse and preview eyes visible while scrolling. Facial Reshape uses tabs for face shape, ratios, eyebrows, eyes, nose, mouth, pose and symmetry.
- Color-related sliders display gradients. Skin and hair colors use swatches; finishes, smiles, iris colors and catchlights use selectable visual references. References are illustrative and save preview recipes.
- Hold a section/group eye to temporarily remove its connected basic adjustments, without changing saved edits or export. AI-only groups explicitly show that their processing engine is not connected; the eye does not simulate an AI result.
- Restore the last Library/Studio view, selected photo and editing category after reload.
- Natural, Soft light and Noir presets, per-photo undo/redo, reset and module reset.
- Hold original, split comparison, 25–1200% zoom relative to Fit, drag-to-pan when enlarged, command/control-wheel zoom, double-click zoom, fit and full-resolution JPEG export.
- Drag the divider below the image workspace to redistribute a fixed viewport between the main photo and filmstrip. Thumbnails range from 28 to 96 px; the divider clamps to both limits and never adds page scroll in desktop Studio. Arrow keys resize; Home/End select the limits. Workspace height is remembered.
- Distinct neutral surface levels separate panel headings, subsection cards and nested controls; light neutral scrollbars.
- Export and keyboard-shortcuts controls appear only in Studio. Clicking a dialog backdrop closes it.

## Phase 1: color engine (November 2026)

Color adjustments now run on the GPU (WebGL2) in `engine/`, for both the preview and full-resolution export.

- **Connected:** every Color control except AI denoise, lens profiles and guided transform. That includes white balance presets, texture, clarity, dehaze, LUT profiles and filters (`.cube` import), levels and curves per channel (with a point-curve editor and black/white point eyedroppers), HSL and black & white mix, color grading, selective color, sharpening, noise reduction, grain, chromatic aberration, distortion, vignetting, defringe, manual and automatic transform (level, upright), and calibration.
- **AI color module:** auto white balance and exposure, reference color matching (also across selected photos), color match and looks. Personalized looks are still previews.
- **Hold-to-compare eyes** now work for every connected group.
- **Models:** `engine/models.js` + `engine/model-worker.js` run ONNX models off the main thread with ONNX Runtime Web (`vendor/`). Each model is pinned by SHA-256 and refused if it doesn't match. YuNet face detection is bundled for phase 2.
- **Security:** a Content-Security-Policy blocks the page from contacting any server. Imported LUTs are stored with the library in IndexedDB.
- **No WebGL?** The app falls back to the original CPU path for the 11 basic sliders.

## Phase 2: portrait retouching (November 2026)

Two local AI models now run in the background worker: **YuNet** finds faces, and **BiSeNet face parsing** splits each face into skin, brows, eyes, glasses, nose, mouth, lips and hair. The retouching itself (`engine/portrait/retouch.js`) is image processing on those masks, so it runs at full resolution on export.

- **Connected:** blemishes (acne, freckles, moles), shine, dark circles, eye bags, glasses glare, lip wrinkles, all 9 wrinkle zones, skin evening/smoothing/softening, texture, clarity, finish and glossiness, complexion, skin tone, temperature, tint, radiance and rosiness, teeth, eyes (brightness, whites, veins, red eye, iris color), highlight and contour, brows, lip makeup, lipstick, blush, and hair color, smoothing, shine and white-hair blackening. The Master slider scales everything.
- **Per person:** the chips show All plus Person 1, 2, ... (left to right). Click a face box on the photo or a chip to edit one person; anything not set for that person follows All.
- **Still previews:** facial reshape, expressions, generated teeth/smiles, body tools, makeup looks, catchlight styles, eyeliner/eyeshadow/lash styles, gender/age targets (no freely licensed classifier).
- **Skin tone presets** change undertone only, never how light or dark the skin is.
- **Model license note:** see `models/NOTICE.txt`. The face parser's weights come from a non-commercial dataset: fine for personal use.

## Feature scaffolding

`features.js` is a structured inventory of editing modules, groups and typed controls. Unimplemented effects are identified by the panel’s control-preview notice and accessible input labels. Their values are saved per photograph (and per chosen portrait target), but never affect pixels. Processing actions save edit-plan intent and explicitly report that processing is not connected.

The inventory includes color, portrait, AI color, masks, backgrounds, clothing, pets, crop/rotate, AI Lab, manual healing/liquify, and workflow/capture. See `FEATURE-COVERAGE.md` for sources, boundaries and the distinction between a control schema and an implemented engine.

## Storage and output limits

The application stores its collection in this browser's IndexedDB for this exact origin. Using another browser, clearing site data or changing the origin does not preserve the same library. Browser storage is not a backup. Folders organize the application's collection and do not move files in Finder. Imported source files are never modified.

If storage is unavailable or full, the interface reports session-only storage. Preview uses a reduced-size image for responsiveness. JPEG export starts from the original decoded image, flattens transparency onto white and applies working basic adjustments only. It does not preserve original metadata, camera profiles or a professional high-bit-depth workflow. RAW development is not included. AI engines arrive in later phases.

Bundled sample image: https://images.unsplash.com/photo-1534528741775-53994a69daeb. No internet connection is needed for the interface after it is loaded locally.
