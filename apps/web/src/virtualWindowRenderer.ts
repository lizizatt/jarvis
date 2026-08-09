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

float lineSegment(vec2 point, vec2 start, vec2 end, float width) {
  vec2 segment = end - start;
  float along = clamp(dot(point - start, segment) / dot(segment, segment), 0.0, 1.0);
  return 1.0 - smoothstep(width, width * 2.0, length(point - start - segment * along));
}

float ring(vec2 point, float radius, float width) {
  return 1.0 - smoothstep(width, width * 2.0, abs(length(point) - radius));
}

float dashedRing(vec2 point, float radius, float width, float phase) {
  float angle = atan(point.y, point.x);
  float dash = smoothstep(-0.15, 0.25, sin(angle * 8.0 + phase));
  return ring(point, radius, width) * dash;
}

float node(vec2 point, vec2 center, float radius) {
  return 1.0 - smoothstep(radius, radius * 1.8, length(point - center));
}

// A 4x4 Bayer matrix keeps the projected marks crisp and deliberately
// pixel-textured without adding random shimmer to their slow animation.
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

// Reimplements the library's layered animation style: counter-rotating
// orbits, independently turning geometry, travelling nodes, and a slow pulse.
float animatedSigil(vec3 ray, vec2 center, float radius, float time, float phase, float variant) {
  float longitude = (center.x - 0.5) * 6.28318530718;
  float latitude = (center.y - 0.5) * 3.14159265359;
  vec3 forward = vec3(sin(longitude) * cos(latitude), sin(latitude), -cos(longitude) * cos(latitude));
  vec3 right = vec3(cos(longitude), 0.0, sin(longitude));
  vec3 up = normalize(cross(right, forward));
  float facing = dot(ray, forward);
  if (facing <= 0.0) return 0.0;

  // Project onto the sigil's tangent plane. Unlike measuring equirectangular
  // UV deltas, this uses the same perspective ray as the panorama and keeps
  // circular marks circular at every latitude and across the texture seam.
  vec2 point = vec2(dot(ray, right), dot(ray, up)) / (facing * radius * 3.14159265359);

  float turn = time * (0.055 + variant * 0.008) + phase;
  float cosine = cos(turn);
  float sine = sin(turn);
  vec2 geometry = mat2(cosine, -sine, sine, cosine) * point;
  float pulse = 0.92 + sin(time * 0.42 + phase) * 0.08;

  float mark = ring(point, 0.78 * pulse, 0.012);
  mark += dashedRing(point, 0.61, 0.009, -time * 0.34 + phase);
  mark += dashedRing(point, 0.48, 0.006, time * 0.26 - phase);
  if (variant < 0.5) {
    mark += lineSegment(geometry, vec2(0.0, -0.70), vec2(-0.61, 0.43), 0.012);
    mark += lineSegment(geometry, vec2(-0.61, 0.43), vec2(0.61, 0.43), 0.012);
    mark += lineSegment(geometry, vec2(0.61, 0.43), vec2(0.0, -0.70), 0.012);
  } else if (variant < 1.5) {
    mark += lineSegment(geometry, vec2(-0.52, -0.52), vec2(0.52, 0.52), 0.012);
    mark += lineSegment(geometry, vec2(0.52, -0.52), vec2(-0.52, 0.52), 0.012);
    mark += lineSegment(geometry, vec2(-0.48, 0.0), vec2(0.48, 0.0), 0.012);
  } else {
    mark += lineSegment(geometry, vec2(0.0, -0.62), vec2(0.50, 0.0), 0.012);
    mark += lineSegment(geometry, vec2(0.50, 0.0), vec2(0.0, 0.62), 0.012);
    mark += lineSegment(geometry, vec2(0.0, 0.62), vec2(-0.50, 0.0), 0.012);
    mark += lineSegment(geometry, vec2(-0.50, 0.0), vec2(0.0, -0.62), 0.012);
  }
  mark += lineSegment(geometry, vec2(-0.68, 0.0), vec2(0.68, 0.0), 0.007);
  mark += lineSegment(geometry, vec2(0.0, -0.68), vec2(0.0, 0.68), 0.007);

  float nodeAngle = time * 0.23 + phase;
  mark += node(point, vec2(cos(nodeAngle), sin(nodeAngle)) * 0.61, 0.035);
  mark += node(point, vec2(cos(-nodeAngle * 0.73), sin(-nodeAngle * 0.73)) * 0.48, 0.025);
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
  // A denser field of half-scale marks keeps each sigil incidental while the
  // varied phases preserve the library-inspired independent choreography.
  float marks = animatedSigil(ray, vec2(0.04, 0.56), 0.040, time, 0.2, 0.0);
  marks += animatedSigil(ray, vec2(0.10, 0.76), 0.030, time, 5.8, 2.0);
  marks += animatedSigil(ray, vec2(0.17, 0.31), 0.034, time, 1.4, 1.0);
  marks += animatedSigil(ray, vec2(0.23, 0.64), 0.028, time, 3.1, 2.0);
  marks += animatedSigil(ray, vec2(0.29, 0.45), 0.038, time, 4.7, 0.0);
  marks += animatedSigil(ray, vec2(0.35, 0.82), 0.025, time, 2.7, 1.0);
  marks += animatedSigil(ray, vec2(0.41, 0.22), 0.032, time, 6.0, 2.0);
  marks += animatedSigil(ray, vec2(0.47, 0.59), 0.036, time, 0.9, 0.0);
  marks += animatedSigil(ray, vec2(0.53, 0.37), 0.027, time, 4.1, 1.0);
  marks += animatedSigil(ray, vec2(0.59, 0.73), 0.033, time, 2.2, 2.0);
  marks += animatedSigil(ray, vec2(0.65, 0.16), 0.026, time, 5.3, 1.0);
  marks += animatedSigil(ray, vec2(0.71, 0.51), 0.039, time, 3.4, 0.0);
  marks += animatedSigil(ray, vec2(0.77, 0.84), 0.029, time, 1.8, 2.0);
  marks += animatedSigil(ray, vec2(0.83, 0.28), 0.035, time, 5.0, 1.0);
  marks += animatedSigil(ray, vec2(0.89, 0.66), 0.031, time, 0.5, 0.0);
  marks += animatedSigil(ray, vec2(0.95, 0.43), 0.037, time, 3.8, 2.0);
  marks = clamp(marks, 0.0, 1.0);

  // Quantize only the sigil layer in screen space. The pattern therefore
  // follows the same spherical projection while the star panorama stays clean.
  float dither = bayer4(gl_FragCoord.xy / 1.5);
  float ditheredMarks = step(dither, marks) * (0.72 + dither * 0.28);
  vec3 sigilColor = vec3(1.0, 0.20, 0.22);
  vec3 color = stars.rgb + sigilColor * ditheredMarks * 0.52;
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
  gl.uniform1i(panoramaLocation, 0);

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
    gl.uniform2f(viewportLocation, canvas.width, canvas.height);
    gl.uniform2f(viewLocation, yaw, pitch);
    gl.uniform1f(timeLocation, elapsedTime);
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
