import fs from "node:fs";
import path from "node:path";

const targetPath = path.join("node_modules", "zero-native", "src", "platform", "macos", "appkit_host.m");

if (!fs.existsSync(targetPath)) {
  console.warn(`zero-native patch skipped: ${targetPath} not found`);
  process.exit(0);
}

const source = fs.readFileSync(targetPath, "utf8");
const patched = source
  .replace('[configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];', '[configuration.preferences setValue:@NO forKey:@"developerExtrasEnabled"];')
  .replace('[webView setValue:@YES forKey:@"inspectable"];', '[webView setValue:@NO forKey:@"inspectable"];');

if (patched === source) {
  if (source.includes('developerExtrasEnabled"]') && source.includes('inspectable"]')) {
    console.log("zero-native WebKit inspector patch already applied");
    process.exit(0);
  }
  throw new Error("zero-native WebKit inspector patch did not match expected source.");
}

fs.writeFileSync(targetPath, patched, "utf8");
console.log("zero-native WebKit inspector patch applied");
