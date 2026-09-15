/**
 * Package version, mirrored from package.json.
 *
 * It is duplicated rather than imported so the compiled output has no
 * dependency on package.json's location at runtime. A unit test asserts the
 * two never drift apart.
 */
export const VERSION = '0.2.0';

export const PACKAGE_NAME = 'iso-cities';

export const PROJECT_URL = 'https://github.com/RayNCooper/iso-cities';
