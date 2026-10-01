import crypto from "crypto";

const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const generarPasswordTemporal = (largo = 12) => Array.from({ length: largo }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join("");

export { generarPasswordTemporal };
