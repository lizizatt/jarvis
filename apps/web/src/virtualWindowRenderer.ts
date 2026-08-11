export type VirtualWindowRenderer = {
  setView(yaw: number, pitch: number, timeSeconds?: number): void;
  resize(): void;
  dispose(): void;
};

type WebGL = WebGLRenderingContext;

const VERTEX_SHADER = `
attribute vec2 position;
varying vec2 screenPosition;
void main() {
  screenPosition = position;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 screenPosition;
uniform sampler2D panorama;
uniform vec2 viewport;
uniform vec2 viewAngles;
uniform float elapsedTime;
uniform vec2 renderTuning;

float lineSegment(vec2 point, vec2 start, vec2 end, float width) {
  vec2 segment = end - start;
  float along = clamp(dot(point - start, segment) / dot(segment, segment), 0.0, 1.0);
  return 1.0 - smoothstep(width, width * 2.0, length(point - start - segment * along));
}

float ring(vec2 point, float radius, float width) {
  return 1.0 - smoothstep(width, width * 2.0, abs(length(point) - radius));
}

float dashedRing(vec2 point, float radius, float width, float phase, float spokes) {
  float angle = atan(point.y, point.x);
  float dash = smoothstep(-0.22, 0.28, sin(angle * spokes + phase));
  return ring(point, radius, width) * dash;
}

float node(vec2 point, vec2 center, float radius) {
  return 1.0 - smoothstep(radius, radius * 1.8, length(point - center));
}

float halo(vec2 point, float radius, float feather) {
  float d = length(point);
  return 1.0 - smoothstep(radius, radius + feather, d);
}

float runeSpoke(vec2 point, float angle, float inner, float outer, float width) {
  vec2 dir = vec2(cos(angle), sin(angle));
  return lineSegment(point, dir * inner, dir * outer, width);
}

float starBurst(vec2 point, float rays, float width, float spin) {
  float angle = atan(point.y, point.x);
  float rayMask = abs(sin(angle * rays + spin));
  float spoke = 1.0 - smoothstep(0.0, width, rayMask);
  float falloff = smoothstep(0.95, 0.08, length(point));
  return spoke * falloff;
}

float spiralRune(vec2 point, float arms, float twist, float width, float phase) {
  float angle = atan(point.y, point.x);
  float radius = length(point);
  float wave = sin(angle * arms + radius * twist + phase);
  float spiral = 1.0 - smoothstep(0.0, width, abs(wave));
  return spiral * smoothstep(0.82, 0.04, radius);
}

float hash11(float value) {
  return fract(sin(value * 127.1) * 43758.5453123);
}

float triWave(float value) {
  return abs(fract(value) - 0.5) * 2.0;
}

float hash21(vec2 value) {
  return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 hash22(vec2 value) {
  return vec2(
    hash21(value + vec2(1.0, 0.0)),
    hash21(value + vec2(0.0, 1.0))
  );
}

float animatedSigil(vec3 ray, vec2 center, float radius, float time, float phase, float variant);

float sigilField(vec3 ray, float time, float quality) {
  const float maxSigils = 108.0;
  float total = 0.0;
  for (int index = 0; index < 108; index++) {
    float fi = float(index);
    if (fi >= quality) break;

    vec2 seed = vec2(fi * 1.13 + 3.7, fi * 1.91 + 9.2);
    vec2 jitter = hash22(seed);
    vec2 center = vec2((fi + 0.5) / maxSigils, 0.04 + jitter.y * 0.92);
    center.x = fract(center.x + (jitter.x - 0.5) * 0.34 + sin(fi * 0.33 + jitter.y * 6.28318530718) * 0.04);
    float radius = mix(0.015, 0.046, hash21(seed + 4.0));
    float phase = hash21(seed + 7.0) * 6.28318530718;
    float variant = floor(hash21(seed + 12.0) * 4.0);
    float layerOffset = hash21(seed + 19.0) * 6.28318530718;
    float shimmer = triWave(time * 0.05 + hash11(fi + 1.0));
    total += animatedSigil(ray, center, radius, time, phase + layerOffset, variant) * mix(0.82, 1.2, shimmer);

    if (quality > 54.0 || mod(fi, 2.0) < 0.5) {
      vec2 echoCenter = vec2(fract(center.x + 0.12 + jitter.y * 0.07), clamp(center.y + (jitter.x - 0.5) * 0.09, 0.03, 0.97));
      float echoRadius = radius * mix(0.52, 0.78, jitter.x);
      total += animatedSigil(ray, echoCenter, echoRadius, time * 1.14, phase + 2.7, mod(variant + 1.0, 4.0)) * 0.52;
    }

    if (quality > 90.0) {
      vec2 twinCenter = vec2(fract(center.x - 0.16 - jitter.x * 0.08), clamp(center.y + (jitter.y - 0.5) * 0.14, 0.02, 0.98));
      float twinRadius = radius * mix(0.34, 0.55, hash21(seed + 31.0));
      total += animatedSigil(ray, twinCenter, twinRadius, time * 0.82, phase - 1.9, mod(variant + 2.0, 4.0)) * 0.34;
    }
  }
  return total;
}

// A 4x4 Bayer matrix keeps projected marks crisp while avoiding noisy shimmer.
float bayer4(vec2 pixel) {
  vec2 cell = mod(floor(pixel), 4.0);
  float x = cell.x;
  float y = cell.y;
  if (y < 1.0) {
    if (x < 1.0) return 0.5 / 16.0;
    if (x < 2.0) return 8.5 / 16.0;
    if (x < 3.0) return 2.5 / 16.0;
    return 10.5 / 16.0;
  }
  if (y < 2.0) {
    if (x < 1.0) return 12.5 / 16.0;
    if (x < 2.0) return 4.5 / 16.0;
    if (x < 3.0) return 14.5 / 16.0;
    return 6.5 / 16.0;
  }
  if (y < 3.0) {
    if (x < 1.0) return 3.5 / 16.0;
    if (x < 2.0) return 11.5 / 16.0;
    if (x < 3.0) return 1.5 / 16.0;
    return 9.5 / 16.0;
  }
  if (x < 1.0) return 15.5 / 16.0;
  if (x < 2.0) return 7.5 / 16.0;
  if (x < 3.0) return 13.5 / 16.0;
  return 5.5 / 16.0;
}

float animatedSigil(vec3 ray, vec2 center, float radius, float time, float phase, float variant) {
  float longitude = (center.x - 0.5) * 6.28318530718;
  float latitude = (center.y - 0.5) * 3.14159265359;
  vec3 forward = vec3(sin(longitude) * cos(latitude), sin(latitude), -cos(longitude) * cos(latitude));
  vec3 right = vec3(cos(longitude), 0.0, sin(longitude));
  vec3 up = normalize(cross(right, forward));
  float facing = dot(ray, forward);
  if (facing <= 0.0) return 0.0;

  vec2 point = vec2(dot(ray, right), dot(ray, up)) / (facing * radius * 3.14159265359);
  float pointRadiusSq = dot(point, point);
  if (pointRadiusSq > 1.69) return 0.0;

  float turn = time * (0.055 + variant * 0.008) + phase;
  float cosine = cos(turn);
  float sine = sin(turn);
  vec2 geometry = vec2(cosine * point.x - sine * point.y, sine * point.x + cosine * point.y);

  float counterTurn = turn * -0.74;
  float counterCos = cos(counterTurn);
  float counterSin = sin(counterTurn);
  vec2 counter = vec2(counterCos * point.x - counterSin * point.y, counterSin * point.x + counterCos * point.y);

  float shimmerTurn = turn * 1.8;
  float shimmerCos = cos(shimmerTurn);
  float shimmerSin = sin(shimmerTurn);
  vec2 shimmer = vec2(shimmerCos * point.x - shimmerSin * point.y, shimmerSin * point.x + shimmerCos * point.y);
  float pulse = 0.92 + sin(time * 0.42 + phase) * 0.08;

  float mark = ring(point, 0.82 * pulse, 0.012);
  mark += ring(point, 0.71, 0.008);
  mark += dashedRing(point, 0.61, 0.010, -time * 0.34 + phase, 8.0 + variant);
  mark += dashedRing(point, 0.48, 0.007, time * 0.26 - phase, 10.0 + variant * 2.0);
  mark += dashedRing(point, 0.34, 0.005, time * 0.55 + phase * 0.3, 16.0);
  mark += dashedRing(point, 0.22, 0.004, -time * 0.75 + phase, 20.0 + variant * 3.0);
  mark += dashedRing(counter, 0.56, 0.005, time * 0.46 + phase * 1.3, 24.0 + variant * 4.0);
  mark += ring(shimmer, 0.14, 0.003);
  mark += ring(counter, 0.11, 0.003);
  mark += ring(geometry, 0.27, 0.003);

  if (variant < 0.5) {
    mark += lineSegment(geometry, vec2(0.0, -0.70), vec2(-0.61, 0.43), 0.012);
    mark += lineSegment(geometry, vec2(-0.61, 0.43), vec2(0.61, 0.43), 0.012);
    mark += lineSegment(geometry, vec2(0.61, 0.43), vec2(0.0, -0.70), 0.012);
  } else if (variant < 1.5) {
    mark += lineSegment(geometry, vec2(-0.52, -0.52), vec2(0.52, 0.52), 0.012);
    mark += lineSegment(geometry, vec2(0.52, -0.52), vec2(-0.52, 0.52), 0.012);
    mark += lineSegment(geometry, vec2(-0.48, 0.0), vec2(0.48, 0.0), 0.012);
  } else if (variant < 2.5) {
    mark += lineSegment(geometry, vec2(0.0, -0.62), vec2(0.50, 0.0), 0.012);
    mark += lineSegment(geometry, vec2(0.50, 0.0), vec2(0.0, 0.62), 0.012);
    mark += lineSegment(geometry, vec2(0.0, 0.62), vec2(-0.50, 0.0), 0.012);
    mark += lineSegment(geometry, vec2(-0.50, 0.0), vec2(0.0, -0.62), 0.012);
  } else {
    mark += lineSegment(geometry, vec2(-0.60, -0.22), vec2(0.0, 0.66), 0.012);
    mark += lineSegment(geometry, vec2(0.60, -0.22), vec2(0.0, 0.66), 0.012);
    mark += lineSegment(geometry, vec2(-0.60, -0.22), vec2(0.60, -0.22), 0.012);
    mark += lineSegment(geometry, vec2(-0.38, 0.08), vec2(0.38, 0.08), 0.010);
    mark += lineSegment(geometry, vec2(0.0, -0.64), vec2(0.0, 0.56), 0.010);
  }

  mark += lineSegment(counter, vec2(-0.68, 0.0), vec2(0.68, 0.0), 0.007);
  mark += lineSegment(counter, vec2(0.0, -0.68), vec2(0.0, 0.68), 0.007);
  mark += lineSegment(counter, vec2(-0.48, -0.48), vec2(0.48, 0.48), 0.005);
  mark += lineSegment(counter, vec2(0.48, -0.48), vec2(-0.48, 0.48), 0.005);
  mark += lineSegment(shimmer, vec2(-0.56, -0.56), vec2(0.56, 0.56), 0.004);
  mark += lineSegment(shimmer, vec2(0.56, -0.56), vec2(-0.56, 0.56), 0.004);

  float spokeSeed = phase * 0.4 + variant;
  mark += runeSpoke(counter, spokeSeed, 0.17, 0.43, 0.006);
  mark += runeSpoke(counter, spokeSeed + 1.047, 0.17, 0.43, 0.006);
  mark += runeSpoke(counter, spokeSeed + 2.094, 0.17, 0.43, 0.006);
  mark += runeSpoke(counter, spokeSeed + 3.14159, 0.11, 0.37, 0.005);
  mark += runeSpoke(shimmer, spokeSeed + 0.33, 0.06, 0.31, 0.004);
  mark += runeSpoke(shimmer, spokeSeed + 1.89, 0.06, 0.31, 0.004);
  mark += runeSpoke(geometry, spokeSeed + 2.62, 0.09, 0.28, 0.004);
  mark += starBurst(shimmer, 6.0 + variant * 2.0, 0.08, time * 0.31 + phase) * 0.28;
  mark += starBurst(counter, 9.0 + variant * 3.0, 0.09, -time * 0.28 + phase) * 0.22;
  mark += starBurst(geometry, 12.0 + variant * 2.0, 0.1, time * 0.44 - phase * 0.6) * 0.17;
  mark += spiralRune(geometry, 4.0 + variant, 11.0, 0.09, time * 0.6 + phase) * 0.24;
  mark += spiralRune(shimmer, 7.0 + variant, -14.0, 0.08, -time * 0.7 + phase * 0.3) * 0.18;
  mark += spiralRune(counter, 5.0 + variant, 17.0, 0.07, time * 0.52 - phase * 0.4) * 0.14;

  float nodeAngle = time * 0.23 + phase;
  mark += node(point, vec2(cos(nodeAngle), sin(nodeAngle)) * 0.61, 0.035);
  mark += node(point, vec2(cos(-nodeAngle * 0.73), sin(-nodeAngle * 0.73)) * 0.48, 0.025);
  mark += node(point, vec2(cos(nodeAngle * 1.24 + 1.9), sin(nodeAngle * 1.24 + 1.9)) * 0.34, 0.020);
  mark += node(point, vec2(cos(nodeAngle * -1.48 + 0.8), sin(nodeAngle * -1.48 + 0.8)) * 0.22, 0.016);
  mark += node(point, vec2(cos(nodeAngle * 2.2 + 2.7), sin(nodeAngle * 2.2 + 2.7)) * 0.74, 0.022);

  mark += halo(point, 0.94, 0.36) * 0.22;
  mark += halo(point, 0.62, 0.22) * 0.12;
  mark += halo(point, 0.31, 0.14) * 0.08;
  return clamp(mark, 0.0, 1.0);
}

void main() {
  float aspect = viewport.x / viewport.y;
  float fieldOfView = radians(62.0);
  vec3 ray = normalize(vec3(
    screenPosition.x * tan(fieldOfView * 0.5) * aspect,
    screenPosition.y * tan(fieldOfView * 0.5),
    -1.0
  ));

  float pitchCos = cos(viewAngles.y);
  float pitchSin = sin(viewAngles.y);
  ray = vec3(ray.x, ray.y * pitchCos - ray.z * pitchSin, ray.y * pitchSin + ray.z * pitchCos);

  float yawCos = cos(viewAngles.x);
  float yawSin = sin(viewAngles.x);
  ray = vec3(ray.x * yawCos - ray.z * yawSin, ray.y, ray.x * yawSin + ray.z * yawCos);

  vec2 uv = vec2(
    atan(ray.x, -ray.z) / (2.0 * 3.14159265359) + 0.5,
    asin(clamp(ray.y, -1.0, 1.0)) / 3.14159265359 + 0.5
  );

  vec4 stars = texture2D(panorama, uv);
  float time = elapsedTime;
  float quality = renderTuning.x;
  float ditherScale = renderTuning.y;
  float marks = sigilField(ray, time, quality);
  float markGlow = smoothstep(0.35, 2.7, marks);
  marks = clamp(marks, 0.0, 1.0);

  float dither = bayer4(gl_FragCoord.xy / ditherScale);
  float ditheredMarks = step(dither, marks) * (0.74 + dither * 0.26);

  float aurora = 0.5 + 0.5 * sin(ray.y * 16.0 + ray.x * 7.5 - time * 0.65);
  aurora *= smoothstep(-0.35, 0.55, ray.y + sin(time * 0.15) * 0.12);

  float flareBand = smoothstep(0.2, 0.88, marks) * (0.6 + 0.4 * sin(time * 0.8 + ray.x * 18.0 + ray.y * 14.0));
  float prism = 0.5 + 0.5 * sin(ray.x * 28.0 + ray.y * 19.0 + time * 0.9);
  float nebula = smoothstep(0.1, 1.0, aurora) * (0.55 + 0.45 * sin(time * 0.33 + ray.x * 9.0));
  float corona = smoothstep(0.52, 1.0, marks) * (0.5 + 0.5 * sin(time * 1.6 + ray.x * 34.0));

  vec3 crimson = vec3(1.0, 0.15, 0.24);
  vec3 violet = vec3(0.72, 0.28, 1.0);
  vec3 cyan = vec3(0.2, 0.96, 0.88);
  vec3 gold = vec3(1.0, 0.78, 0.28);
  vec3 ember = mix(crimson, violet, 0.45 + 0.45 * sin(time * 0.37 + ray.x * 5.0));
  vec3 prismColor = mix(violet, cyan, prism);
  vec3 auroraColor = vec3(0.14, 0.48, 0.44) * aurora * 0.16;

  float bloom = smoothstep(0.4, 1.0, marks) * (0.74 + 0.26 * sin(time * 1.1 + ray.y * 21.0));
  float spectral = smoothstep(0.2, 0.95, marks) * (0.5 + 0.5 * sin(time * 0.63 + ray.x * 31.0 - ray.y * 17.0));

  vec3 color = stars.rgb * vec3(0.88, 0.9, 1.0);
  color += ember * ditheredMarks * 0.66;
  color += prismColor * flareBand * 0.28;
  color += mix(cyan, crimson, spectral) * bloom * 0.18;
  color += mix(gold, cyan, prism) * corona * 0.12;
  color += auroraColor;
  color += vec3(0.1, 0.03, 0.14) * marks * 0.3;
  color += vec3(0.06, 0.09, 0.15) * nebula * 0.2;
  color += vec3(0.08, 0.05, 0.18) * markGlow * 0.14;
  gl_FragColor = vec4(color, 1.0);
}`;

function compileShader(gl: WebGL, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function createVirtualWindowRenderer(canvas: HTMLCanvasElement, imageUrl: string): VirtualWindowRenderer | null {
  const context = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: 'low-power'
  });
  if (!context || typeof context.createShader !== 'function') return null;
  const gl: WebGL = context;

  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!buffer || !texture) {
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([7, 9, 9, 255]));

  const panoramaLocation = gl.getUniformLocation(program, 'panorama');
  const viewportLocation = gl.getUniformLocation(program, 'viewport');
  const viewLocation = gl.getUniformLocation(program, 'viewAngles');
  const timeLocation = gl.getUniformLocation(program, 'elapsedTime');
  const renderTuningLocation = gl.getUniformLocation(program, 'renderTuning');
  if (panoramaLocation) gl.uniform1i(panoramaLocation, 0);

  let yaw = 0;
  let pitch = 0;
  let elapsedTime = 0;
  let disposed = false;
  let imageReady = false;

  function resize() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
  }

  function draw() {
    if (disposed) return;
    resize();
    gl.useProgram(program);

    const pixelCount = canvas.width * canvas.height;
    let sigilQuality = 56;
    if (pixelCount > 700_000) sigilQuality = 84;
    if (pixelCount > 1_300_000) sigilQuality = 108;
    const ditherScale = pixelCount > 1_300_000 ? 1.35 : 1.15;

    gl.uniform2f(viewportLocation, canvas.width, canvas.height);
    gl.uniform2f(viewLocation, yaw, pitch);
    gl.uniform1f(timeLocation, elapsedTime);
    if (renderTuningLocation) gl.uniform2f(renderTuningLocation, sigilQuality, ditherScale);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (imageReady) canvas.dataset.ready = 'true';
  }

  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    if (disposed) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    imageReady = true;
    draw();
  };
  image.src = imageUrl;
  draw();

  return {
    setView(nextYaw, nextPitch, nextTime = 0) {
      yaw = nextYaw;
      pitch = nextPitch;
      elapsedTime = nextTime;
      draw();
    },
    resize: draw,
    dispose() {
      disposed = true;
      image.onload = null;
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    }
  };
}
