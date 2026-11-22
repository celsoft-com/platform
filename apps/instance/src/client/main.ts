import { mount } from "svelte";
import "./lib/service-dark/tokens.css";
import "./lib/service-dark/bundle.css";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });
