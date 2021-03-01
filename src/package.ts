import fetch, { Response } from "node-fetch";
import npmPackageArg from "npm-package-arg";
import semver from "semver";
import fs from "fs";
import path from "path";
import { StatusCode } from "status-code-enum";

export type PackageFullName = string;
export type PackageName = string;
export type PackageSemanticVersion = string;
export type PackageVersion = string;
interface APIResponse {
    dependencies?: object;
    dist?: { shasum: string, tarball: string; }
    versions?: { [version: string]: any };
}
interface APIRequest {
    name: PackageName,
    version?: PackageVersion
}
function fullNameByNameAndVersion(name: string, version: string): PackageFullName {
    return `${name}@${version}`;
}
enum Errors {
    NOT_FOUND = "not found",
    NO_TARBALL = "no tarball",
    TOO_MANY_FAILURES = "too many failures",
    REGISTRY_ERROR = "REGISTRY_ERROR"
}
export default class Package {
    static readonly MAX_TRIES: number = 10;

    public dependencies: Package[] = [];
    public dependents: Package[] = [];
    public error: boolean = false;
    public loading: boolean = false;
    public name: string;
    public resolved: boolean = false;
    public tarballURL: string | undefined;
    public version: string;

    static cache: Map<PackageFullName, Package> = new Map();
    static apiCache: Map<PackageName, APIResponse> = new Map();

    public get isRoot(): boolean {
        return this.dependents.length === 0;
    }
    public get fullName(): PackageFullName {
        return fullNameByNameAndVersion(this.name, this.version);
    }
    public get tgzFileName(): string | undefined {
        if (!this.tarballURL) {
            return;
        }
        return path.basename(this.tarballURL!);
    }
    protected constructor(name: string, version?: string) {
        this.name = name;
        this.version = version ?? "latest";
    }

    public addDependent(pkg: Package) {
        if (!this.dependents.includes(pkg)) {
            this.dependents.push(pkg);
        }
    }

    public async download(): Promise<void> {
        if (!this.tarballURL || !this.tgzFileName) {
            throw "not enough data for download tgz file";
        }
        console.log(`downloading ${this}...`);
        let triesCount = 0;
        let tgzFileData: Buffer;
        do {
            try {
                const response = await fetch(this.tarballURL!);
                if (!response) continue;
                tgzFileData = await response.buffer();
                if (!tgzFileData) continue;
                break;
            } catch (error) {
                // TODO: different errors
            }
        } while (++triesCount < Package.MAX_TRIES);
        if (triesCount == Package.MAX_TRIES) throw "`downloading ${this} failed`";
        fs.writeFileSync(path.resolve(process.cwd(), this.tgzFileName), tgzFileData!);
        // TODO: add shasum check.
    }
    async getDependencies(): Promise<Package[]> {
        this.loading = true;
        const result: Package[] = [];
        let responseBodyAsJSON: APIResponse;
        try {
            responseBodyAsJSON = await Package.apiRequest({ name: this.name, version: this.version });
        } catch (error) {
            switch (error) {
                case Errors.REGISTRY_ERROR:
                    return result;
                default:
                    
                    this.error = true;
                    this.loading = false;
                    throw error;
            }
        }
        this.tarballURL = responseBodyAsJSON!.dist?.tarball;
        if (responseBodyAsJSON!.dependencies == undefined) { // special case: dependencies node doesn't exist, but tarball exists.
            return result;
        }

        for (const pkg of Object.entries(responseBodyAsJSON!.dependencies)) {
            const packageName = pkg[0];
            const packageSemanticVersion = pkg[1];

            const dependency = await Package.fromSemanticVersion(packageName, packageSemanticVersion);
            // check for cyclic dependency (I.E. https://registry.npmjs.org/@types/koa-compose/latest)
            if (this.isAncestorEqual(dependency)) {
                continue;
            }
            dependency.addDependent(this);
            result.push(dependency);
        }

        // const semverPromises = Object.entries(responseBodyAsJSON.dependencies).map(
        //     async (pkg: [string, string]) => {
        //         const packageName = pkg[0];
        //         const packageSemanticVersion = pkg[1];

        //         const dependency = await Package.fromSemanticVersion(packageName, packageSemanticVersion);
        //         // check for cyclic dependency (I.E. https://registry.npmjs.org/@types/koa-compose/latest)
        //         if (this.isAncestorEqual(dependency)) {
        //             return;
        //         }
        //         dependency.addDependent(this);
        //         result.push(dependency);
        //     }
        // );
        // await Promise.all(semverPromises);


        this.dependencies = result;
        return result;
    }
    public isAncestorEqual(pkg: Package): boolean {
        if (pkg.isEqual(this)) {
            return true;
        }
        if (this.isRoot) {
            return false;
        }
        return this.dependents.some((dependent) => dependent.isAncestorEqual(pkg));
    }
    public isEqual(pkg: Package): boolean {
        return pkg.fullName === this.fullName;
    }
    public toString(): string {
        return this.fullName;
    }

    public static async apiRequest(apiRequest: APIRequest): Promise<APIResponse> {
        const cachedResponse = Package.apiCache.get(apiRequest.name);
        if (cachedResponse) {
            if (apiRequest.version) {
                return cachedResponse!.versions![apiRequest.version!];
            } else {
                return cachedResponse;
            }
        }

        if (!apiRequest.version) {
            apiRequest.version = "";
        }

        let apiResponse: APIResponse;
        let triesCount = 0;
        do {
            let response: Response | undefined = undefined;
            try {
                response = await fetch(`https://registry.npmjs.org/${apiRequest.name}/${apiRequest.version!}`); // `npm view` returns inconsistent format. so i made direct call to registry
            } catch (error) {
                // TODO: Different errors
            }
            if (!response) {
                continue;
            }
            if (!response.ok) {
                switch (response.status) {
                    case StatusCode.ClientErrorNotFound:
                        throw Errors.REGISTRY_ERROR;
                    default:
                        throw response.statusText;
                }
            }
            try {
                apiResponse = await <APIResponse>(<unknown>(response.json()));
                if (!apiResponse) {
                    continue;
                }
                break;
            } catch (error) {
                // TODO: Different errors
            }
        } while (++triesCount < Package.MAX_TRIES);
        if (triesCount == Package.MAX_TRIES) {
            throw Errors.TOO_MANY_FAILURES;
        }
        if (apiRequest.version == "") {
            Package.apiCache.set(apiRequest.name, apiResponse!);
        }
        return apiResponse!;
    }
    static fillCacheByFullNames(fullNames: PackageFullName[]) {
        for (const fullName of fullNames) {
            const pkg = Package.fromString(fullName);
            if (pkg === undefined) continue;
            pkg!.resolved = true;
            this.cache.set(fullName, pkg);
        }
    }
    public static fromNameAndVersion(name: string, version: string): Package {
        const fullName = fullNameByNameAndVersion(name, version);
        const cachedPkg = Package.cache.get(fullName);
        if (cachedPkg) {
            return cachedPkg;
        } else {
            const result = new Package(name, version);
            this.cache.set(result.fullName, result);
            return result;
        }
    }
    public static async fromSemanticVersion(name: PackageName, semanticVersion: PackageSemanticVersion): Promise<Package> {
        let version: string = semanticVersion;
        if (semanticVersion === "*") {
            version = "latest";
        } else if (semanticVersion.includes("<") || semanticVersion.includes("-")) {
            let apiResponse: APIResponse;
            try {
                apiResponse = await Package.apiRequest({ name: name });

            } catch (error) {
                throw error;
            }
            version = semver.maxSatisfying(Object.keys(apiResponse!.versions!), semanticVersion) ?? "latest";
        } else {
            version = semver.coerce(semanticVersion)?.version ?? "latest";
        }
        return this.fromNameAndVersion(name, version);
    }
    static fromString(pacakgeNameInAnyFormat: string): Package | undefined {
        try {
            const pacakgeArgResult = npmPackageArg(pacakgeNameInAnyFormat);
            const packageName: string = pacakgeArgResult.name!;
            const packageVersion: string | undefined =
                pacakgeArgResult.fetchSpec ?? "latest";
            return Package.fromNameAndVersion(packageName, packageVersion);
        } catch (ex) {
            return undefined;
        }
    }
}