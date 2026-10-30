// GLSL for the frame renderer. Every quad is placed in output pixels with the top left as origin.

export const VERTEX = `#version 300 es
precision highp float;
uniform vec4 uRect;
uniform vec2 uOut;
uniform float uFlip;
out vec2 vPx;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vPx = uRect.xy + corner * uRect.zw;
  vec2 ndc = vPx / uOut * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y * uFlip, 0.0, 1.0);
}`

const HEAD = `#version 300 es
precision highp float;
in vec2 vPx;
out vec4 outColor;
`

// One image source, either RGB or three YUV planes
const SOURCE = `
uniform sampler2D uRgb;
uniform sampler2D uY;
uniform sampler2D uU;
uniform sampler2D uV;
uniform bool uIsYuv;
uniform vec4 uCoef;
uniform float uChromaShift;
vec3 fetchSource(vec2 uv) {
  if (!uIsYuv) return texture(uRgb, uv).rgb;
  vec2 c = uv + vec2(uChromaShift, 0.0);
  float y = 1.16438 * (texture(uY, uv).r - 0.0627451);
  float u = 1.13839 * (texture(uU, c).r - 0.5019608);
  float v = 1.13839 * (texture(uV, c).r - 0.5019608);
  return vec3(y + uCoef.x * v, y - uCoef.y * u - uCoef.z * v, y + uCoef.w * u);
}
`

const ROUND_BOX = `
float roundBox(vec2 p, vec2 center, vec2 half_, float r) {
  vec2 q = abs(p - center) - half_ + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
`

// Wallpaper, shadow and screen. p is canvas px, so the camera moves all three together
export const SCENE = `${HEAD}${SOURCE}${ROUND_BOX}
uniform sampler2D uBg;
uniform vec2 uOut;
uniform vec4 uCam;
uniform vec4 uScreen;
uniform float uRadius;
uniform float uShadow;
uniform vec4 uBgMap;
uniform vec2 uStep;
uniform bool uSuper;
float dither(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))) - 0.5;
}
vec3 screenColor(vec2 uv) {
  if (!uSuper) return fetchSource(uv);
  return 0.25 * (
    fetchSource(uv + uStep * vec2(0.125, 0.375)) +
    fetchSource(uv + uStep * vec2(-0.375, 0.125)) +
    fetchSource(uv + uStep * vec2(0.375, -0.125)) +
    fetchSource(uv + uStep * vec2(-0.125, -0.375)));
}
void main() {
  vec2 p = uCam.xy + vPx / uOut * uCam.zw;
  float pixel = uCam.z / uOut.x;
  vec3 color = texture(uBg, uBgMap.xy + p * uBgMap.zw).rgb + dither(vPx) / 255.0;
  vec2 center = uScreen.xy + uScreen.zw * 0.5;
  vec2 half_ = uScreen.zw * 0.5;
  float blur = uScreen.z * 0.04;
  float drop = roundBox(p - vec2(0.0, uScreen.z * 0.022), center, half_, uRadius);
  color *= 1.0 - uShadow * (1.0 - smoothstep(-blur, blur, drop));
  float d = roundBox(p, center, half_, uRadius);
  float cover = clamp(0.5 - d / pixel, 0.0, 1.0);
  if (cover > 0.0) color = mix(color, screenColor((p - uScreen.xy) / uScreen.zw), cover);
  outColor = vec4(color, 1.0);
}`

// Dolly's own arrow, as a distance field so it stays sharp at any size
export const CURSOR = `${HEAD}
uniform vec2 uTip;
uniform float uUnit;
const vec2 HOTSPOT = vec2(2.0, 1.5);
const vec2 V[4] = vec2[4](vec2(2.0, 1.5), vec2(15.5, 9.2), vec2(9.5, 10.5), vec2(6.5, 16.0));
float arrow(vec2 p) {
  float d = dot(p - V[0], p - V[0]);
  float s = 1.0;
  for (int i = 0, j = 3; i < 4; j = i, i++) {
    vec2 e = V[j] - V[i];
    vec2 w = p - V[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= V[i].y, p.y < V[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
void main() {
  vec2 p = (vPx - uTip) / uUnit + HOTSPOT;
  float aa = 0.75 / uUnit;
  float d = arrow(p);
  float fill = 1.0 - smoothstep(-aa, aa, d + 0.7);
  float edge = 1.0 - smoothstep(-aa, aa, d - 0.7);
  float soft = 0.35 * (1.0 - smoothstep(-0.5, 2.4, arrow(p - vec2(0.0, 0.9))));
  float a = edge + soft * (1.0 - edge);
  vec3 color = mix(vec3(1.0), vec3(0.067), fill) * edge;
  outColor = vec4(color, a);
}`

export const RIPPLE = `${HEAD}
uniform vec2 uCenter;
uniform float uRing;
uniform float uWidth;
uniform float uFade;
void main() {
  const vec3 blue = vec3(0.176, 0.388, 0.961);
  float dist = length(vPx - uCenter);
  float disc = clamp(uRing - dist + 0.5, 0.0, 1.0);
  float ring = clamp(uWidth * 0.5 - abs(dist - uRing) + 0.5, 0.0, 1.0);
  float a = max(disc * 0.14, ring) * uFade;
  outColor = vec4(blue * a, a);
}`

// Fixed to the output. uBox is the bubble in output px
export const WEBCAM = `${HEAD}${SOURCE}${ROUND_BOX}
uniform vec4 uBox;
uniform float uRadius;
uniform vec2 uCrop;
void main() {
  vec2 half_ = uBox.zw * 0.5;
  vec2 center = uBox.xy + half_;
  float d = roundBox(vPx, center, half_, uRadius);
  float cover = clamp(0.5 - d, 0.0, 1.0);
  float soft = 0.3 * (1.0 - smoothstep(0.0, uBox.z * 0.1, roundBox(vPx - vec2(0.0, uBox.z * 0.02), center, half_, uRadius)));
  vec2 uv = 0.5 + ((vPx - center) / uBox.zw) * uCrop;
  vec3 color = cover > 0.0 ? fetchSource(uv) : vec3(0.0);
  outColor = vec4(color * cover, cover + soft * (1.0 - cover));
}`

export const IMAGE = `${HEAD}
uniform sampler2D uImage;
uniform vec4 uBox;
void main() {
  outColor = texture(uImage, (vPx - uBox.xy) / uBox.zw);
}`
