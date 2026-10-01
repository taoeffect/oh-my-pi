import { downloadBinary, readPackageJson } from "./lib.js";

try {
	const binary = await downloadBinary(await readPackageJson(), { log: message => console.log(message) });
	console.log(`Installed omp to ${binary}`);
} catch (error) {
	console.error(`Failed to install omp: ${error.message}`);
	process.exit(1);
}
