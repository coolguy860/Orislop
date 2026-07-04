import { mountApp } from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Orislop root element was not found.");
}

mountApp(root);
