/* Motus-Touch color engine: WebGL2, runs entirely on this computer's GPU.
   Pipeline: geometry -> noise reduction/defringe -> color -> sharpen/grain.
   Same code renders the 1600px preview and the full-resolution export. */
'use strict';

const MotusGL = (() => {

const VERT = `#version 300 es
in vec2 pos; out vec2 vUv;
void main(){ vUv = pos*0.5+0.5; gl_Position = vec4(pos,0.,1.); }`;

const HEAD = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 vUv; out vec4 outColor;
float luma(vec3 c){ return dot(c, vec3(.2126,.7152,.0722)); }
vec3 rgb2hsl(vec3 c){ float mx=max(c.r,max(c.g,c.b)), mn=min(c.r,min(c.g,c.b)), l=(mx+mn)*.5, d=mx-mn, h=0., s=0.;
  if(d>1e-5){ s = l>.5 ? d/(2.-mx-mn) : d/(mx+mn);
    if(mx==c.r) h=(c.g-c.b)/d+(c.g<c.b?6.:0.); else if(mx==c.g) h=(c.b-c.r)/d+2.; else h=(c.r-c.g)/d+4.; h*=60.; }
  return vec3(h,s,l); }
float hue2c(float p,float q,float t){ t=fract(t); if(t<1./6.) return p+(q-p)*6.*t; if(t<.5) return q; if(t<2./3.) return p+(q-p)*(2./3.-t)*6.; return p; }
vec3 hsl2rgb(vec3 h){ if(h.y<1e-5) return vec3(h.z); float q=h.z<.5?h.z*(1.+h.y):h.z+h.y-h.z*h.y, p=2.*h.z-q, t=h.x/360.;
  return vec3(hue2c(p,q,t+1./3.),hue2c(p,q,t),hue2c(p,q,t-1./3.)); }
`;

// geometry: perspective/rotate/scale/offset, lens distortion, lateral chromatic aberration
const GEOM = HEAD + `
uniform sampler2D src; uniform mat3 invH; uniform float aspect, distK, caR, caB;
vec2 toSrc(vec2 q){ return q/vec2(aspect,1.)+.5; }
bool inside(vec2 u){ return all(greaterThanEqual(u,vec2(0.))) && all(lessThanEqual(u,vec2(1.))); }
void main(){
  vec2 p = (vUv-.5)*vec2(aspect,1.);
  vec3 h = invH*vec3(p,1.); vec2 q = h.xy/h.z;
  q *= 1. + distK*dot(q,q);
  vec2 u = toSrc(q);
  if(!inside(u)){ outColor = vec4(0.); return; }
  vec4 s0 = texture(src,u); vec3 c = s0.rgb;
  if(caR!=0. || caB!=0.){ c.r = texture(src,toSrc(q*(1.+caR))).r; c.b = texture(src,toSrc(q*(1.+caB))).b; }
  c = mix(vec3(1.), c, s0.a);   // transparent areas flatten onto white, as in export
  outColor = vec4(c,1.);
}`;

// bilateral luminance noise reduction, chroma smoothing and purple/green fringe removal
const NR = HEAD + `
uniform sampler2D src, blurC; uniform vec2 texel;
uniform float lumAmt, lumRadius, rangeSigma, lumContrast, colAmt, colDetail, defPurple, defGreen;
void main(){
  vec4 s = texture(src,vUv); vec3 c = s.rgb; float a = s.a;
  float y = luma(c); vec3 chroma = c - y;
  if(lumAmt>0.){
    float sum=0., wsum=0.;
    for(int j=-3;j<=3;j++) for(int i=-3;i<=3;i++){
      vec2 o = vec2(i,j)*lumRadius/3.;
      float yy = luma(texture(src, vUv+o*texel).rgb);
      float w = exp(-dot(o,o)/(2.*lumRadius*lumRadius+1e-3)) * exp(-(yy-y)*(yy-y)/(2.*rangeSigma*rangeSigma));
      sum += yy*w; wsum += w; }
    float ys = sum/wsum;
    y = mix(y, ys + (y-ys)*lumContrast, lumAmt);
  }
  if(colAmt>0.){
    vec3 b = texture(blurC,vUv).rgb; vec3 bc = b - luma(b);
    float keep = colDetail*smoothstep(.02,.12,length(chroma-bc));
    chroma = mix(chroma, bc, colAmt*(1.-keep));
  }
  if(defPurple>0. || defGreen>0.){
    float mn=1., mx=0.;
    for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){ float v=luma(texture(src,vUv+vec2(i,j)*texel*1.5).rgb); mn=min(mn,v); mx=max(mx,v); }
    float edge = smoothstep(.12,.35,mx-mn);
    vec3 hs = rgb2hsl(y+chroma);
    float purple = smoothstep(250.,270.,hs.x)*(1.-smoothstep(320.,340.,hs.x));
    float green = smoothstep(75.,95.,hs.x)*(1.-smoothstep(150.,170.,hs.x));
    float k = edge*hs.y*(purple*defPurple + green*defGreen);
    chroma *= 1.-clamp(k,0.,1.);
  }
  outColor = vec4(y+chroma, a);
}`;

const COLOR = HEAD + `
uniform sampler2D src, blurT, blurCl, blurD, curveLut;
uniform sampler3D lutProfile, lutFilter, lutLook;
uniform float exposure, contrast, brightness, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation;
uniform float texAmt, clarAmt, dehazeAmt; uniform vec3 airLight;
uniform int bw; uniform float bwMix[8];
uniform vec3 hsl[8];
uniform vec3 gradeS, gradeM, gradeH, gradeG; uniform float gradeBlend, gradeBal;
uniform vec4 sel[11]; uniform int selRelative;
uniform mat3 calib; uniform float shadowTint;
uniform vec3 ref1Mean, ref1Std, src1Mean, src1Std; uniform float ref1Amt;
uniform vec3 ref2Mean, ref2Std, src2Mean, src2Std; uniform float ref2Amt;
uniform float profileAmt, filterAmt, lookAmt, lutSizeP, lutSizeF, lutSizeL;
uniform float vignette, aspect;

const float CENT[8] = float[8](0.,30.,60.,120.,180.,240.,270.,300.);
void hueWeights(float h, out float w[8]){
  for(int i=0;i<8;i++) w[i]=0.;
  for(int i=0;i<8;i++){ float a=CENT[i], b=i==7?360.:CENT[i+1];
    if(h>=a && h<b){ float t=(h-a)/(b-a); w[i]=1.-t; w[i==7?0:i+1]=t; } }
}
vec3 toLinear(vec3 c){ return mix(c/12.92, pow((c+.055)/1.055,vec3(2.4)), step(.04045,c)); }
vec3 toGamma(vec3 c){ c=max(c,0.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-.055, step(.0031308,c)); }
vec3 rgb2lab(vec3 c){ vec3 l=toLinear(clamp(c,0.,1.));
  vec3 x = mat3(.4124,.2126,.0193, .3576,.7152,.1192, .1805,.0722,.9505)*l; x/=vec3(.95047,1.,1.08883);
  vec3 f = mix(7.787*x+16./116., pow(x,vec3(1./3.)), step(.008856,x));
  return vec3(116.*f.y-16., 500.*(f.x-f.y), 200.*(f.y-f.z)); }
vec3 lab2rgb(vec3 lab){ float fy=(lab.x+16.)/116.; vec3 f=vec3(fy+lab.y/500., fy, fy-lab.z/200.);
  vec3 x = mix((f-16./116.)/7.787, f*f*f, step(.206893,f))*vec3(.95047,1.,1.08883);
  vec3 l = mat3(3.2406,-.9689,.0557, -1.5372,1.8758,-.2040, -.4986,.0415,1.0570)*x; return toGamma(l); }
vec3 matchStats(vec3 c, vec3 sm, vec3 ss, vec3 rm, vec3 rs, float amt){
  vec3 lab = rgb2lab(c); vec3 m = (lab-sm)/max(ss,vec3(1e-3))*rs + rm; return mix(c, lab2rgb(m), amt); }
vec3 applyLut(sampler3D t, float n, vec3 c){ c=clamp(c,0.,1.); return texture(t, c*(n-1.)/n + .5/n).rgb; }

void main(){
  vec4 s = texture(src,vUv); if(s.a==0.){ outColor=vec4(0.); return; }
  vec3 c = s.rgb;

  // reference matching
  if(ref1Amt>0.) c = matchStats(c, src1Mean, src1Std, ref1Mean, ref1Std, ref1Amt);
  if(ref2Amt>0.) c = matchStats(c, src2Mean, src2Std, ref2Mean, ref2Std, ref2Amt);

  // dehaze (dark channel prior, blurred transmission)
  if(dehazeAmt!=0.){
    float dark = texture(blurD,vUv).a;
    if(dehazeAmt>0.){ float t = max(1. - .95*dehazeAmt*dark/max(max(airLight.r,max(airLight.g,airLight.b)),.05), .25);
      c = (c-airLight)/t + airLight; }
    else c = mix(c, airLight, -dehazeAmt*.45);
  }

  // white balance + exposure (same math as the original Motus-Touch basic panel)
  float ex = exp2(exposure/2.2), warm = temperature*.0018, ti = tint*.0012;
  c = c*ex*vec3(1.+warm+ti*.35, 1.-ti, 1.-warm+ti*.35);

  // texture & clarity: local contrast at two scales, on luminance
  if(texAmt!=0. || clarAmt!=0.){
    float y = luma(c), d = 0.;
    // big differences mean a hard edge: compress them so local contrast doesn't halo
    if(texAmt!=0.){ float hp = y - luma(texture(blurT,vUv).rgb)*ex; d += texAmt*1.4*hp/(1.+abs(hp)*8.); }
    if(clarAmt!=0.){ float mid = 1.-pow(abs(2.*clamp(y,0.,1.)-1.),2.); float hp = y - luma(texture(blurCl,vUv).rgb)*ex; d += clarAmt*2.*mid*hp/(1.+abs(hp)*12.); }
    c += clamp(d,-.25,.25);
  }

  // tone
  float lum = clamp(luma(c),0.,1.), dk = 1.-lum;
  float adj = shadows*.0023*dk*dk*dk + highlights*.0023*lum*lum*lum + whites*.0018*pow(lum,6.) + blacks*.0018*pow(dk,6.) + brightness*.0015*4.*lum*dk;
  float con = 1.+contrast/100.;
  c = (c+adj-.5)*con+.5;
  float l = luma(c), spread = max(c.r,max(c.g,c.b))-min(c.r,min(c.g,c.b));
  float sat = (1.+saturation/100.)*(1.+vibrance/100.*.65*(1.-min(1.,spread)));
  c = l + (c-l)*sat;

  // calibration
  c = calib*c;
  if(shadowTint!=0.){ float sh = pow(1.-clamp(luma(c),0.,1.),2.); c += vec3(.5,-1.,.5)*shadowTint*.04*sh; }

  // custom profile LUT
  if(profileAmt>0.) c = mix(c, applyLut(lutProfile,lutSizeP,c), profileAmt);

  // HSL or black & white mix
  float w[8]; vec3 hs = rgb2hsl(clamp(c,0.,1.)); hueWeights(hs.x,w);
  if(bw==1){
    float mixv = 0.; for(int i=0;i<8;i++) mixv += w[i]*bwMix[i];
    float y = luma(c)*(1.+mixv*.6*hs.y);
    c = vec3(y);
  } else {
    vec3 d = vec3(0.); for(int i=0;i<8;i++) d += w[i]*hsl[i];
    if(any(notEqual(d,vec3(0.)))){
      hs.x = mod(hs.x + d.x*30., 360.); hs.y = clamp(hs.y*(1.+d.y), 0., 1.);
      float chroma = clamp(hs.y*2.,0.,1.);
      vec3 base = clamp(c,0.,1.); vec3 oc = hsl2rgb(hs);
      oc *= 1. + d.z*.45*chroma;
      c = oc + (c-base);
    }
  }

  // levels + curves (composite per-channel LUT)
  c = clamp(c,0.,1.);
  c = vec3(texture(curveLut,vec2(c.r*1023./1024.+.5/1024.,.5)).r, texture(curveLut,vec2(c.g*1023./1024.+.5/1024.,.5)).g, texture(curveLut,vec2(c.b*1023./1024.+.5/1024.,.5)).b);

  // color grading
  {
    float y = luma(c), pivot = .5+gradeBal*.3, width = .15+gradeBlend*.35;
    float ws = pow(1.-smoothstep(0.,pivot+width*.5,y), 1.5-gradeBlend);
    float wh = pow(smoothstep(pivot-width*.5,1.,y), 1.5-gradeBlend);
    float wm = clamp(1.-ws-wh,0.,1.);
    vec3 t;
    if(gradeS.y>0.){ t=hsl2rgb(vec3(gradeS.x,1.,.5)); c += (t-luma(t))*gradeS.y*ws*.35; } c += gradeS.z*.25*ws;
    if(gradeM.y>0.){ t=hsl2rgb(vec3(gradeM.x,1.,.5)); c += (t-luma(t))*gradeM.y*wm*.35; } c += gradeM.z*.25*wm;
    if(gradeH.y>0.){ t=hsl2rgb(vec3(gradeH.x,1.,.5)); c += (t-luma(t))*gradeH.y*wh*.35; } c += gradeH.z*.25*wh;
    if(gradeG.y>0.){ t=hsl2rgb(vec3(gradeG.x,1.,.5)); c += (t-luma(t))*gradeG.y*.35; } c += gradeG.z*.25;
  }

  // selective color (CMYK-style, per color family + whites/neutrals/blacks)
  {
    vec3 cc = clamp(c,0.,1.); float mx=max(cc.r,max(cc.g,cc.b)), mn=min(cc.r,min(cc.g,cc.b));
    vec3 h2 = rgb2hsl(cc); float w2[8]; hueWeights(h2.x,w2);
    vec3 delta = vec3(0.);
    for(int i=0;i<11;i++){
      vec4 a = sel[i]; if(a==vec4(0.)) continue;
      float wt = i<8 ? w2[i]*(mx-mn) : i==8 ? max(0.,(mn-.5)*2.) : i==9 ? max(0.,1.-abs(mx-.5)-abs(mn-.5)) : max(0.,(.5-mx)*2.);
      if(wt<=0.) continue;
      vec3 cmy = selRelative==1 ? (1.-cc)*a.xyz : a.xyz;
      vec3 k = selRelative==1 ? cc*a.w : vec3(a.w);
      delta -= (cmy + k*.5)*wt;
    }
    c += delta;
  }

  // filter / look LUTs
  if(filterAmt>0.) c = mix(c, applyLut(lutFilter,lutSizeF,c), filterAmt);
  if(lookAmt>0.) c = mix(c, applyLut(lutLook,lutSizeL,c), lookAmt);

  // lens vignetting
  if(vignette!=0.){ vec2 p=(vUv-.5)*vec2(aspect,1.)/length(vec2(aspect,1.)*.5); float r2=dot(p,p); c *= 1.+vignette*.8*r2*r2; }

  outColor = vec4(c, 1.);
}`;

const FINISH = HEAD + `
uniform sampler2D src; uniform vec2 texel, fullSize;
uniform float shAmt, shRadius, shDetail, shMask, grainAmt, grainSize, grainRough, seed;
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)+seed); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
void main(){
  vec4 s = texture(src,vUv); vec3 c = s.rgb;
  if(s.a==0.){ outColor=vec4(0.); return; }
  if(shAmt>0.){
    float y = luma(c), b = 0., wsum = 0., gx = 0., gy = 0.;
    for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){ vec2 o=vec2(i,j)*shRadius*.5; float w=exp(-dot(o,o)/(2.*shRadius*shRadius*.25+1e-3));
      float v = luma(texture(src,vUv+o*texel).rgb); b+=v*w; wsum+=w; gx+=v*float(i); gy+=v*float(j); }
    b/=wsum;
    float hp = y-b;
    hp = sign(hp)*min(abs(hp), mix(.04,.25,shDetail));          // detail: lower = fewer halos
    float edge = smoothstep(shMask*.15, shMask*.15+.02, length(vec2(gx,gy))*.1);
    c += hp*shAmt*2.5*(shMask>0.?edge:1.);
  }
  if(grainAmt>0.){
    vec2 p = vUv*fullSize/grainSize;
    float n = vnoise(p)-.5; n += (vnoise(p*2.7+13.1)-.5)*grainRough;
    float y = clamp(luma(c),0.,1.);
    c += n*grainAmt*.22*(1.-pow(abs(2.*y-1.),2.)*.6);
  }
  outColor = vec4(clamp(c,0.,1.), s.a);
}`;

const DOWN = HEAD + `
uniform sampler2D src; uniform vec2 srcTexel; uniform int prep;
void main(){
  vec2 o = srcTexel*.5; vec4 a=texture(src,vUv+vec2(-o.x,-o.y)), b=texture(src,vUv+vec2(o.x,-o.y)), c=texture(src,vUv+vec2(-o.x,o.y)), d=texture(src,vUv+vec2(o.x,o.y));
  if(prep==1){ a.a=min(a.r,min(a.g,a.b)); b.a=min(b.r,min(b.g,b.b)); c.a=min(c.r,min(c.g,c.b)); d.a=min(d.r,min(d.g,d.b)); }
  outColor = (a+b+c+d)*.25;
}`;

const GAUSS = HEAD + `
uniform sampler2D src; uniform vec2 dir; uniform float sigma;
void main(){
  vec4 sum = texture(src,vUv); float wsum = 1.;
  for(int i=1;i<=12;i++){ float x=float(i); if(x>sigma*3.) break; float w=exp(-x*x/(2.*sigma*sigma));
    sum += (texture(src,vUv+dir*x)+texture(src,vUv-dir*x))*w; wsum += 2.*w; }
  outColor = sum/wsum;
}`;

const BLIT = HEAD + `
uniform sampler2D src; uniform int flip;
void main(){ vec2 u = flip==1 ? vec2(vUv.x,1.-vUv.y) : vUv; outColor = texture(src,u); }`;

class Engine {
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserve, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl; this.canvas = canvas;
    this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.lowPrecision = !!opts.lowPrecision;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const buf = this.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    this.programs = {};
    for (const [name, src] of Object.entries({ GEOM, NR, COLOR, FINISH, DOWN, GAUSS, BLIT })) this.programs[name] = this._program(src);
    this.pool = new Map(); this.sourceTex = null; this.luts = {};
    this.curveTex = this._tex(1024, 1, gl.RGBA32F ?? gl.RGBA, gl.RGBA, gl.FLOAT, true);
    this.emptyLut = this._lut3d(2, new Float32Array([0,0,0, 1,0,0, 0,1,0, 1,1,0, 0,0,1, 1,0,1, 0,1,1, 1,1,1]));
  }
  _program(fs) {
    const gl = this.gl, p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'pos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const uniforms = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); uniforms[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type }; }
    return { p, uniforms };
  }
  _tex(w, h, internal, format, type, nearest = false, data = null) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    const f = nearest ? gl.LINEAR : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _lut3d(n, data) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    return { tex: t, size: n };
  }
  setLut(slot, lut) { // lut: {size, data Float32Array rgb, r fastest} or null
    if (this.luts[slot]?.key === lut?.key) return;
    if (this.luts[slot]?.tex) this.gl.deleteTexture(this.luts[slot].tex);
    this.luts[slot] = lut ? { ...this._lut3d(lut.size, lut.data), key: lut.key } : null;
  }
  // render target from a pool; float when possible so local edits don't band
  _target(name, w, h) {
    const gl = this.gl, key = `${name}:${w}x${h}`;
    let t = this.pool.get(key);
    if (!t) {
      const hi = this.floatOK && !this.lowPrecision;
      const tex = this._tex(w, h, hi ? gl.RGBA16F : gl.RGBA8, gl.RGBA, hi ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(tex); gl.deleteFramebuffer(fb);
        if (hi) { this.lowPrecision = true; this.releaseTargets(); return this._target(name, w, h); }   // GPU can't render to half-float: use 8-bit
        throw new Error('GPU could not create a render target');
      }
      t = { tex, fb, w, h }; this.pool.set(key, t);
    }
    return t;
  }
  releaseTargets() { const gl = this.gl; for (const t of this.pool.values()) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } this.pool.clear(); }
  setSource(image, width, height) {
    const gl = this.gl;
    if (width > this.maxSize || height > this.maxSize) throw new Error(`This GPU handles images up to ${this.maxSize}px per side.`);
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);
    this.sourceTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    if (this.w !== width || this.h !== height) this.releaseTargets();
    this.w = width; this.h = height;
  }
  _draw(prog, target, uniforms, textures = {}) {
    const gl = this.gl, P = this.programs[prog];
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      const u = P.uniforms[name]; if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      const is3d = u.type === gl.SAMPLER_3D;
      gl.bindTexture(is3d ? gl.TEXTURE_3D : gl.TEXTURE_2D, tex);
      gl.uniform1i(u.loc, unit++);
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const u = P.uniforms[name]; if (!u) continue;
      switch (u.type) {
        case gl.FLOAT: Array.isArray(v) || v instanceof Float32Array ? gl.uniform1fv(u.loc, v) : gl.uniform1f(u.loc, v); break;
        case gl.INT: gl.uniform1i(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // Gaussian blur at reduced resolution; alpha carries the dark channel (min rgb) for dehaze
  _blur(name, src, sigma) {
    let w = this.w, h = this.h, f = 1, cur = src, first = true;
    while (sigma / f > 3 && Math.min(w, h) > 32) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2)); f *= 2;
      const t = this._target(`${name}-d${f}`, w, h);
      this._draw('DOWN', t, { srcTexel: [1 / (cur.w || this.w), 1 / (cur.h || this.h)], prep: first ? 1 : 0 }, { src: cur.tex });
      cur = t; first = false;
    }
    if (first) { const t = this._target(`${name}-p`, w, h); this._draw('DOWN', t, { srcTexel: [0, 0], prep: 1 }, { src: cur.tex }); cur = t; }
    const s = Math.max(.5, sigma / f), a = this._target(`${name}-h`, w, h), b = this._target(`${name}-v`, w, h);
    this._draw('GAUSS', a, { dir: [1 / w, 0], sigma: s }, { src: cur.tex });
    this._draw('GAUSS', b, { dir: [0, 1 / h], sigma: s }, { src: a.tex });
    return b;
  }
  setCurves(data) { // Float32Array 1024*4
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.floatLinear() ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.floatLinear() ? gl.LINEAR : gl.NEAREST);
  }
  floatLinear() { return this._fl ??= !!this.gl.getExtension('OES_texture_float_linear'); }

  /* U: uniforms prepared by MotusParams.toUniforms(); returns the final target */
  render(U) {
    const W = this.w, H = this.h, src = { tex: this.sourceTex, w: W, h: H };
    const g = this._target('geom', W, H);
    this._draw('GEOM', g, U.geom, { src: src.tex });
    let cur = g;
    const nr = U.nr;
    if (nr.lumAmt > 0 || nr.colAmt > 0 || nr.defPurple > 0 || nr.defGreen > 0) {
      const bc = nr.colAmt > 0 ? this._blur('bc', g, U.sigmas.color) : g;
      const t = this._target('nr', W, H);
      this._draw('NR', t, { ...nr, texel: [1 / W, 1 / H] }, { src: g.tex, blurC: bc.tex });
      cur = t;
    }
    const tex = { src: cur.tex, blurT: cur.tex, blurCl: cur.tex, blurD: cur.tex, curveLut: this.curveTex,
      lutProfile: (this.luts.profile || this.emptyLut).tex, lutFilter: (this.luts.filter || this.emptyLut).tex, lutLook: (this.luts.look || this.emptyLut).tex };
    if (U.color.texAmt) tex.blurT = this._blur('bt', cur, U.sigmas.texture).tex;
    if (U.color.clarAmt) tex.blurCl = this._blur('bcl', cur, U.sigmas.clarity).tex;
    if (U.color.dehazeAmt) tex.blurD = this._blur('bd', cur, U.sigmas.dehaze).tex;
    const c = this._target('color', W, H);
    this._draw('COLOR', c, { ...U.color, lutSizeP: (this.luts.profile || this.emptyLut).size, lutSizeF: (this.luts.filter || this.emptyLut).size, lutSizeL: (this.luts.look || this.emptyLut).size }, tex);
    const f = this._target('final', W, H);
    this._draw('FINISH', f, { ...U.finish, texel: [1 / W, 1 / H], fullSize: U.fullSize }, { src: c.tex });
    this.finalTarget = f;
    return f;
  }
  present() { // draw final target onto the visible canvas (flip to screen orientation)
    if (this.canvas.width !== this.w || this.canvas.height !== this.h) { this.canvas.width = this.w; this.canvas.height = this.h; }
    this._draw('BLIT', null, { flip: 1 }, { src: this.finalTarget.tex });
  }
  readPixels(target = this.finalTarget) { // top-down RGBA8
    const gl = this.gl, out = new Uint8ClampedArray(target.w * target.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    if (this.floatOK && !this.lowPrecision) {
      // read float target via an 8-bit copy
      const t8 = this._target8('read8', target.w, target.h);
      this._draw('BLIT', t8, { flip: 0 }, { src: target.tex });
      gl.bindFramebuffer(gl.FRAMEBUFFER, t8.fb);
    }
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return new ImageData(out, target.w, target.h);
  }
  _target8(name, w, h) {
    const gl = this.gl, key = `${name}:${w}x${h}`; let t = this.pool.get(key);
    if (!t) { const tex = this._tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); t = { tex, fb, w, h }; this.pool.set(key, t); }
    return t;
  }
  destroy() { this.releaseTargets(); this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}

return { Engine };
})();
