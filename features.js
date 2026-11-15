/* Motus-Touch feature inventory. These are control schemas, not AI implementations.
   Reviewed against Evoto Desktop UI and its official support pages, 2026-11-12.
   Sources and coverage boundaries: FEATURE-COVERAGE.md. */
'use strict';
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const slider = (label, extra={}) => ({label,type:'range',min:0,max:100,step:1,value:0,...extra});
const signed = label => slider(label,{min:-100});
const toggle = label => ({label,type:'toggle',value:false});
const select = (label, options) => ({label,type:'select',options,value:options[0]});
const action = label => ({label,type:'action'});
const many = (names,fn=slider) => names.split('|').map(n=>fn(n));
const group = (title, controls) => ({title,controls});
const section = (title, groups, extra={}) => ({title,groups,...extra});
const paired = names => names.split('|').flatMap(n=>[signed(`${n} · left`),signed(`${n} · right`)]);
const working = (key,label,min=-100,max=100,step=1,track='') => slider(label,{key,min,max,step,working:true,track});
const channelNames=['Red','Orange','Yellow','Green','Aqua','Blue','Purple','Magenta'];
const FEATURE_MODULES = [
{id:'color',title:'Color adjustments',short:'Color',icon:'palette',sections:[
 section('Basic',[
  group('White balance',[select('White balance',['Custom','As shot','Daylight','Cloudy','Shade','Tungsten','Fluorescent','Flash']),working('temperature','Temperature',-100,100,1,'temperature'),working('tint','Tint',-100,100,1,'tint')]),
  group('Tone',[working('exposure','Exposure',-2,2,.05),working('contrast','Contrast',-50,50),working('brightness','Brightness'),working('highlights','Highlights'),working('shadows','Shadows'),working('whites','Whites'),working('blacks','Blacks')]),
  group('Presence',[...many('Texture|Clarity|Dehaze',signed),working('vibrance','Vibrance',-100,100,1,'saturation'),working('saturation','Saturation',-100,100,1,'saturation')])
 ],{open:true}),
 section('Profile & filters',[group('Profile',[select('Color profile',['Standard','Black & white','Custom LUT']),action('Import LUT profile')]),group('Filters',[select('Filter collection',['Portrait','Film','Black & white','Custom']),slider('Filter intensity'),action('Import filter')])]),
 section('Levels',[group('Channel',[select('Levels channel',['RGB','Red','Green','Blue']),slider('Input black',{max:255}),slider('Input gamma',{min:.1,max:3,step:.01,value:1}),slider('Input white',{max:255,value:255}),slider('Output black',{max:255}),slider('Output white',{max:255,value:255}),action('Sample black point'),action('Sample white point')])]),
 section('Curves',[group('Curve editor',[select('Curve channel',['RGB','Red','Green','Blue']),select('Curve mode',['Point','Parametric']),...many('Highlights|Lights|Darks|Shadows',signed),action('Add curve point'),action('Reset curve')])]),
 section('HSL / black & white',channelNames.map(h=>group(h,['Hue','Saturation','Luminance'].map(n=>slider(`${h} ${n.toLowerCase()}`,{min:-100,track:n==='Hue'?'rainbow':n==='Saturation'?'saturation':''}))))),
 section('Color grading',['Shadows','Midtones','Highlights','Global'].map(t=>group(t,[slider(`${t} hue`,{max:360,track:'rainbow'}),slider(`${t} saturation`,{track:'saturation'}),signed(`${t} luminance`)] )).concat([group('Mix',[slider('Blending',{value:50}),signed('Balance')])])),
 section('Selective color',[group('Channel',[select('Color channel',[...channelNames,'Whites','Neutrals','Blacks']),...many('Cyan|Magenta|Yellow|Black',signed),select('Method',['Relative','Absolute'])])]),
 section('Detail',[group('AI denoise',[slider('AI denoise amount'),toggle('Enhance detail')]),group('Sharpening',many('Amount|Radius|Detail|Masking')),group('Noise reduction',many('Luminance|Luminance detail|Luminance contrast|Color noise|Color detail|Color smoothness'))]),
 section('Grain',[group('Film texture',many('Amount|Size|Roughness'))]),
 section('Lens corrections',[group('Optics',[toggle('Remove chromatic aberration'),toggle('Enable lens profile'),select('Lens profile',['Auto detect','Custom']),signed('Distortion'),signed('Vignetting'),slider('Defringe purple'),slider('Defringe green')])]),
 section('Transform correction',[group('Automatic',[action('Auto transform'),action('Level'),action('Vertical'),action('Guided correction')]),group('Manual',many('Vertical|Horizontal|Rotate|Aspect|Scale|X offset|Y offset',signed)),group('Edges',[toggle('Constrain crop')])]),
 section('Color calibration',[group('Primaries',[signed('Shadows tint'),signed('Red primary hue'),signed('Red primary saturation'),signed('Green primary hue'),signed('Green primary saturation'),signed('Blue primary hue'),signed('Blue primary saturation')])])
]},
{id:'portrait',title:'Portrait retouching',short:'Portrait',icon:'face',sections:[
 section('Master & targets',[group('Portrait settings',[slider('Master slider',{value:100}),action('Detect faces'),action('Add individual target'),toggle('Link portrait settings'),action('Manual target correction')])]),
 section('Blemish removal',[
 group('Face refinement',[slider('Freckles & acne'),slider('Freckles'),slider('Acne'),toggle('Face mole removal'),slider('Reduce face shine'),slider('Dark circles'),slider('Eye bags'),slider('Lower eyelids protection',{value:100}),slider('Remove glasses glare'),slider('Nostril cleanup'),slider('Lip wrinkles & flakes'),slider('Double chin'),slider('Double chin intensity',{value:90}),slider('Double chin shadow',{value:80}),toggle('Beard protection')]),
 group('Facial wrinkles',[...many('Forehead wrinkles|Eleven lines|Eye wrinkles|Nasal wrinkles|Smile line · left|Smile line · right|Cheek wrinkles|Marionette lines|Perioral wrinkles')]),
 group('Body refinement',many('Body blemishes|Infant body blemishes|Neck wrinkles|Armpit touch-up|Stomach stretch marks|Pregnancy line|Body hair removal')),
 group('Local refinements',[toggle('Tattoo masking'),action('Manual tuning brush')])],{open:true}),
 section('Skin retouching',[
 group('Facial skin',many('Even with dodge & burn|Sculpt facial features|Sculpt facial contours|Textured smoothing|Frequency separation · high|Frequency separation · low|Skin softening')),
 group('Body skin',many('Body dodge & burn|Body frequency · high|Body frequency · low|Body skin softening')),
 group('Skin texture',[select('Texture finish',['Custom','Matte','Satin','Dewy']),...many('Glossiness|Texture|Clarity',signed)]),
 group('Skin tone',[slider('Unify face complexion'),slider('Unify body complexion'),slider('Face-to-body complexion'),slider('Remove tan lines'),select('Skin tone',['Original','Tone 1','Tone 2','Tone 3','Tone 4','Tone 5','Tone 6','Tone 7','Tone 8']),slider('Skin tone intensity'),signed('Skin temperature'),signed('Skin tint'),slider('Skin radiance'),signed('Rosy complexion'),action('Sample complexion'),action('Manual tuning brush')])]),
 section('Facial reshape',[
 group('Head pose',many('Head up / down|Head left / right|Head tilt',signed)),
 group('Face shape',[toggle('Link left / right'),...many('Face|Temple|Cheekbone|Jaw|Face size|V-shape|Jawline length|Face width|Hairline|Forehead height|Forehead width|Philtrum|Middle section|Lower section|Taper chin|Chin length|Chin shape',signed),...paired('Face width|Forehead height|Forehead width')]),
 group('Eyebrows',many('Eyebrow thickness|Eyebrow distance|Eyebrow tilt|Arch height|Eyebrow position',signed)),
 group('Eye shape',many('Full eye size|Eyeball size|Eye height|Eye width|Eye distance|Inner corner|Outer corner|Eye tilt|Eye position',signed)),
 group('Nose',many('Nose size|Nose length|Nose horizontal|Nose bridge|Nose width|Nose tip',signed)),
 group('Mouth',many('Mouth size|Mouth width|Mouth vertical|Mouth horizontal|M-shaped lips|Mouth tilt|Upper lip|Lower lip',signed)),
 group('Symmetry',[slider('Facial symmetry'),slider('Upper body symmetry'),action('Manual tuning brush')])]),
 section('Facial expression',[group('Subtle expression',[...paired('Gummy smile'),slider('Gentle smile')]),group('Smile generation',[select('Smile style',['Original','Open-mouth smile','Closed-mouth smile','Neutral expression']),slider('Open smile level',{max:5}),slider('Closed smile level',{max:3}),action('Generate smile'),action('Manual tuning brush')])]),
 section('Teeth',[group('Refine',[slider('Teeth flaws removal'),toggle('Fix teeth edge'),slider('Teeth whitening'),slider('Teeth brightness'),slider('Teeth desaturation'),slider('Teeth alignment',{max:5}),action('Generate pretty teeth')])]),
 section('Eyes',[group('Brightness',[toggle('Link eye adjustments'),...many('Eye brightness|Iris brightness|Eye whites brightness|Eye reflection|Iris flare|Remove glasses glare|Red vein removal|Eye white cleanse'),toggle('Red eye removal')]),group('Symmetry',[toggle('Eye symmetry'),toggle('Eye level'),slider('Eye balance'),select('Reference eye',['Automatic','Left','Right']),slider('AI iris correction')]),group('Catchlights',[select('Catchlight category',['General','Indoor']),select('Catchlight style',['Original',...Array.from({length:12},(_,i)=>`Style ${i+1}`)]),slider('Catchlight intensity'),signed('Catchlight horizontal'),signed('Catchlight vertical'),signed('Catchlight rotation'),toggle('Flip catchlight'),action('Manual tuning brush')])]),
 section('Makeup',[group('Definition',[slider('Highlight'),slider('Contour'),signed('Eyebrow makeup')]),group('Existing eye makeup',many('Eye makeup amount|Eye makeup saturation|Eye makeup brightness|Eye makeup dimensionality',signed)),group('Existing lip makeup',many('Lip makeup amount|Lip makeup saturation|Lip makeup luminance|Lip makeup dimensionality',signed)),group('Makeup looks',[select('Makeup suite',['Original',...Array.from({length:22},(_,i)=>`Look ${i+1}`)]),slider('Makeup intensity')]),group('Individual components',['Eyebrows','Eyeshadow','Eyelashes','Eyeliner','Contacts','Blush','Lipstick'].flatMap(n=>[select(`${n} style`,['Original','Custom style']),slider(`${n} amount`)]))]),
 section('Hair',[group('Shape & density',many('Hair part line fill|Top hair volume|Side hair volume|Hairline',signed)),group('Cleanup',many('Stray hairs · inside silhouette|Stray hairs · outside silhouette|Smooth hair|Tame frizzy hair|Hair shine|White hair blackening')),group('Hair color',[select('Hair color',['Original','Black','Brown','Blonde','Custom']),slider('Hair color amount'),signed('Hair color temperature'),slider('Hair color saturation'),action('Golden blonde hair'),action('Manual tuning brush')])]),
 section('Hands',[group('Refinement',[slider('Hand vein removal'),action('Manual tuning brush')])]),
 section('Full body reshape',[group('Overall',[signed('AI reshape'),slider('Smooth physique'),toggle('Protect background')]),group('Proportions',[toggle('Link body sides'),...many('Body|Height|Upper body length|Head size|Neck width|Neck length|Arms|Chest|Waist width|Waist length|Hips|Leg width|Thigh width|Calf width|Leg length|Thigh length|Calf length',signed)]),group('Refinement',[action('Manual tuning brush'),action('Liquify background repair')])])
]},
{id:'ai-color',title:'AI color adjustments',short:'AI color',icon:'spark',sections:[
 section('Auto color correction',[group('Balance',[toggle('AI white balance'),toggle('AI exposure'),action('Apply auto color')])],{open:true}),
 section('Color consistency',[group('Reference matching',[select('Match region',['Overall color','Background color']),action('Choose reference image'),slider('Match strength'),action('Match selected photos')])]),
 section('AI color looks',[group('Style',[select('Look',['Natural','Portrait','Film','Custom']),slider('Look intensity'),action('Apply look')])]),
 section('AI color match',[group('Reference',[action('Import reference'),slider('Color match amount'),action('Match color')])]),
 section('Personalized AI look',[group('Your style',[action('Add before / after pairs'),action('Train personal look'),slider('Personal look amount')])])
]},
{id:'masking',title:'Masking',short:'Masks',icon:'mask',sections:[
 section('Person masks',[group('Target',[action('Detect people'),select('Person region',['Entire person','Face skin','Body skin','All skin','Neck','Hair','Eyebrows','Iris','Eye whites','Lips','Teeth','Ears','Clothing','Tops','Inner layer','Dress','Bottom','Shoes','Headwear','Gloves','Bag','Jewelry']),action('Create person mask')])],{open:true}),
 section('Background & pet masks',[group('Selection',[select('Region',['Background','Sky','Ground','Vegetation','Water','Reef','Entire pet']),action('Create region mask')])]),
 section('Custom masks',[group('Tools',[select('Mask tool',['Brush','Linear gradient','Radial gradient','Luminance range','Color range','Subject','Background']),...many('Brush size|Softness|Flow|Density'),toggle('Invert mask')])]),
 section('Smart selection',[group('Selection tools',[select('Selection tool',['Object selection','Quick selection','Magic wand']),select('Operation',['New','Add','Subtract','Intersect']),slider('Edge refinement'),slider('Feather'),slider('Tolerance'),action('Refine edges')])]),
 section('Mask management',[group('Layers',[toggle('Show mask overlay'),action('Rename mask'),action('Duplicate mask'),action('Add to mask'),action('Subtract from mask'),action('Delete mask'),action('Save mask preset')])])
]},
{id:'background',title:'Background adjustments',short:'Backdrop',icon:'landscape',sections:[
 section('Solid backdrop refinement',[group('Detection',[select('Backdrop mode',['Automatic','Solid backdrop','Non-solid backdrop']),toggle('Remove distractions')]),group('Clean backdrop',many('Backdrop cleanup|Ground cleanup')),group('Lighting',[toggle('Unify lighting'),slider('Lighting amount'),signed('Lighting luminance'),slider('Color banding removal')])],{open:true}),
 section('Background enhancement',[group('Refine',[slider('Enhancement'),slider('Background blur'),action('Manual tuning brush')])]),
 section('Backdrop changer',[group('Replacement',[select('Backdrop type',['Solid color','Gradient','Image','Transparent']),{label:'Backdrop color',type:'color',value:'#244b83'},action('Import backdrop'),slider('Preserved area'),slider('Edge softness'),slider('Foreground protection'),signed('Subject relighting'),action('Manual tuning brush')])]),
 section('Sky replacement',[group('Sky',[action('Choose sky image'),slider('Sky amount'),signed('Sky temperature'),signed('Sky tint'),signed('Sky saturation'),signed('Sky brightness'),signed('Horizon position'),slider('Edge transition'),slider('Scene relighting'),toggle('Flip sky'),action('Manual tuning brush')])])
]},
{id:'clothing',title:'Clothes & accessories',short:'Clothes',icon:'shirt',sections:[
 section('De-wrinkle clothing',[group('Fabric refinement',many('De-wrinkle amount|Fine wrinkles|Coarse wrinkles'))],{open:true}),
 section('Clothing cleanup',[group('Details',[slider('De-blemish clothing'),slider('Clothing edge smoothing'),slider('Edge refinement'),toggle('Protect nearby objects'),action('Manual tuning brush')])]),
 section('Fabric repair',[group('Specialist tools',[action('Clothing moiré removal'),action('Sweat stain removal')])])
]},
{id:'pets',title:'Pet retouching',short:'Pets',icon:'paw',sections:[
 section('Body & fur',[group('Cleanup',[action('Remove leash'),slider('Stray fur removal'),action('Manual tuning brush')])],{open:true}),
 section('Pet eyes',[group('Brightness',[toggle('Link pet eyes'),slider('Eye lightening'),slider('Eye color enhancement')]),group('Catchlights',[select('Pet catchlight category',['General','Indoor','Outdoor']),select('Pet catchlight style',['Original','Custom style']),slider('Pet catchlight amount'),signed('Pet catchlight horizontal'),signed('Pet catchlight vertical'),signed('Pet catchlight rotation'),toggle('Flip pet catchlight')])])
]},
{id:'crop',title:'Crop & rotate',short:'Crop',icon:'crop',sections:[
 section('Crop',[group('Composition',[select('Aspect ratio',['Original','Free','1:1','4:5','5:7','2:3','3:2','16:9','9:16','Custom']),slider('Crop width',{max:10000}),slider('Crop height',{max:10000}),toggle('Lock ratio'),select('Overlay',['Rule of thirds','Grid','Golden ratio','None']),action('Apply crop')])],{open:true}),
 section('Face locate',[group('Portrait framing',[select('Photo type',['Custom','Headshot','Passport','ID photo','School portrait']),slider('Head position'),slider('Head size'),slider('Top margin'),action('Locate face')])]),
 section('Rotate & straighten',[group('Alignment',[signed('Straighten angle'),action('Rotate left 90°'),action('Rotate right 90°'),toggle('Flip horizontal'),toggle('Flip vertical'),action('AI correction')])]),
 section('Expand',[group('Canvas',[select('Expand ratio',['Original','Free','1:1','4:5','16:9']),...many('Expand top|Expand right|Expand bottom|Expand left'),action('Generate expansion')])])
]},
{id:'lab',title:'AI lab',short:'AI lab',icon:'spark',sections:[
 section('Background & scene',[group('Scene composition',[action('AI background fusion'),action('Import background asset'),action('Add foreground layer'),select('Recognition mode',['Subject only','Subject + connected objects']),slider('Subject scale'),signed('Subject rotation'),slider('Character lighting'),action('Save scene preset'),action('Batch generate scenes')])],{open:true}),
 section('Remove & repair',[group('Removal',[select('Removal mode',['Quick','Magic']),slider('Removal brush size'),slider('Removal softness'),toggle('Subject protection'),toggle('Edge optimization'),action('Smart removal'),action('Detect passersby'),action('People removal'),action('Clothing moiré removal'),action('Strong glare removal'),action('Sweat stain removal')])]),
 section('Subject adjustments',[group('Refinements',[action('Belly slimming'),action('AI sky replacement'),action('Face shadow removal'),action('Grass fill'),action('Golden blonde hair'),action('Body hair removal')])]),
 section('Enhance & restore',[group('Restore',[action('Liquify background repair'),toggle('Colorize old photo'),select('Restoration resolution',['2K','4K']),action('Old photo restoration')]),group('Enhance',[select('Enhance resolution',['Original','2K','4K','6K']),action('Detail enhance'),action('Batch enhance')])])
]},
{id:'workflow',title:'Workflow & capture',short:'Workflow',icon:'workflow',sections:[
 section('Camera connection',[group('Tethered shooting',[select('Connection',['Wired','Wireless']),select('Camera',['Auto detect','Canon','Nikon','Sony','Fujifilm','Other']),action('Connect camera'),toggle('Live view'),select('Capture preset',['None','Custom']),action('Capture photo')])],{open:true}),
 section('Auto import & export',[group('Hot folders',[action('Choose watched folder'),toggle('Auto import'),select('Import preset',['None','Custom']),toggle('Auto export'),action('Choose export folder'),select('Auto export format',['JPEG','PNG','TIFF']),slider('JPEG quality',{value:95})])]),
 section('Smart culling',[group('Review',[toggle('Detect blur'),toggle('Detect closed eyes'),toggle('Group similar photos'),toggle('Select best expression'),action('Analyze photos')])]),
 section('Batch editing',[group('Settings',[action('Copy edit recipe'),action('Paste edit recipe'),action('Sync selected photos'),action('Batch export')])]),
 section('Assets & presets',[group('Library',[action('Save preset'),action('Import preset'),action('Export preset'),action('Import asset pack'),action('Create workflow template')])])
]}
];
FEATURE_MODULES.splice(FEATURE_MODULES.length-1,0,{id:'manual',title:'Manual retouching',short:'Manual',icon:'sliders',sections:[
 section('Liquify',[group('Brush tool',[select('Liquify tool',['Forward warp','Reconstruct','Smooth','Twirl clockwise','Pucker','Bloat','Push left','Freeze mask','Thaw mask']),...many('Brush size|Brush density|Brush pressure|Brush rate'),toggle('Pin image edges'),toggle('Show freeze mask'),action('Reconstruct all'),action('Apply liquify')])],{open:true}),
 section('Healing',[group('Spot healing',[slider('Healing brush size'),slider('Healing hardness'),action('Start spot healing')]),group('Patch',[select('Patch mode',['Source','Destination']),action('Start patch tool')]),group('Clone stamp',[slider('Clone size'),slider('Clone hardness'),slider('Clone opacity',{value:100}),select('Clone blend mode',['Normal','Multiply','Screen','Lighten','Darken']),action('Set clone source'),action('Start clone stamp')])]),
 section('Tuning brush',[group('Local effects',[select('Tuning mode',['Add effect','Erase effect','Restore original']),slider('Tuning brush size'),slider('Tuning softness'),slider('Tuning flow'),slider('Tuning density'),toggle('Show original and mask'),action('Apply manual tuning')])])
]});
FEATURE_MODULES.find(m=>m.id==='portrait').sections.find(s=>s.title==='Eyes').groups.push(group('Eye color',[select('Iris color',['Original','Brown','Hazel','Green','Blue','Gray','Amber']),slider('Iris color amount')]));
for(const module of FEATURE_MODULES)for(const [si,s] of module.sections.entries())for(const [gi,g] of s.groups.entries())for(const [ci,c] of g.controls.entries())c.id=`${module.id}.${slug(s.title)}.${slug(g.title)}.${c.key||slug(c.label)}.${ci}`;
