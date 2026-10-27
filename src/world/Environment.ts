import * as THREE from 'three';

const CONFIG = {
  skyTop: '#5fb8f0',
  horizon: '#bfe6ff',
  fogNear: 180,
  fogFar: 520,
  /** Sun offset from the focus; shadows fall toward +x/+z (camera's lower-right). */
  sunOffset: new THREE.Vector3(45, 70, 10),
  shadowHalf: 45,
  shadowMapSize: 2048,
};

export class Environment {
  readonly sun: THREE.DirectionalLight;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene.background = new THREE.Color(CONFIG.horizon);
    scene.fog = new THREE.Fog(CONFIG.horizon, CONFIG.fogNear, CONFIG.fogFar);
    scene.add(this.buildSky());
    scene.add(this.buildClouds());

    scene.add(new THREE.HemisphereLight('#9fd6ff', '#e0803f', 1.0));

    this.sun = new THREE.DirectionalLight('#fff1d6', 2.6);
    this.sun.position.copy(CONFIG.sunOffset);
    this.sun.castShadow = true;
    const h = CONFIG.shadowHalf;
    const cam = this.sun.shadow.camera;
    cam.left = -h;
    cam.right = h;
    cam.top = h;
    cam.bottom = -h;
    cam.near = 1;
    cam.far = 220;
    this.sun.shadow.mapSize.set(CONFIG.shadowMapSize, CONFIG.shadowMapSize);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);
  }

  /** Keep the sun and its shadow frustum centred on the focus (snapped to shadow texels to avoid shimmer). */
  update(focus: THREE.Vector3): void {
    const texel = (CONFIG.shadowHalf * 2) / CONFIG.shadowMapSize;
    const x = Math.round(focus.x / texel) * texel;
    const y = Math.round(focus.y / texel) * texel;
    const z = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(x, y, z);
    this.sun.position.set(x, y, z).add(CONFIG.sunOffset);
    this.sun.target.updateMatrixWorld();
  }

  /** Gradient dome pinned to the far plane, so it never clips regardless of camera.far. */
  private buildSky(): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(CONFIG.skyTop) },
        horizon: { value: new THREE.Color(CONFIG.horizon) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          mat4 v = viewMatrix;
          v[3].xyz = vec3(0.0);
          vec4 p = projectionMatrix * v * vec4(position, 1.0);
          gl_Position = p.xyww * vec4(1.0, 1.0, 1.0, 1.0);
          gl_Position.z = p.w * 0.99999;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        varying vec3 vDir;
        void main() {
          float t = smoothstep(0.0, 0.55, vDir.y);
          gl_FragColor = vec4(mix(horizon, top, t), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 24, 12), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    return mesh;
  }

  /** A few big puffy low-poly clouds, far away. */
  private buildClouds(): THREE.Group {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false });
    const puff = new THREE.IcosahedronGeometry(1, 1);
    const layout: [number, number, number, number][] = [
      // angle, distance, height, scale
      [0.3, 420, 120, 26], [1.4, 450, 140, 32], [2.4, 400, 110, 22],
      [3.5, 460, 130, 30], [4.4, 430, 150, 28], [5.5, 410, 115, 24],
    ];
    for (const [a, d, y, s] of layout) {
      const cloud = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const m = new THREE.Mesh(puff, mat);
        m.position.set((i - 2) * s * 0.7, Math.sin(i * 1.7) * s * 0.15, Math.cos(i * 2.3) * s * 0.25);
        m.scale.set(s * (0.8 + 0.2 * Math.cos(i)), s * 0.5, s * 0.6);
        cloud.add(m);
      }
      cloud.position.set(Math.cos(a) * d, y, Math.sin(a) * d);
      cloud.rotation.y = -a + Math.PI / 2;
      group.add(cloud);
    }
    return group;
  }
}
