import { Plugin } from "@opencode/plugin";

const POLICY = `Dependency policy:
Use existing project code, installed dependencies, and platform APIs first.
Do not add, replace, or upgrade dependencies unless the user explicitly requests or approves the specific dependency change.
This applies to runtime, development, optional, and peer dependencies, including changes through commands, manifests, lockfiles, or workspace catalogs.
Before requesting approval, name the proposed package and explain what it solves, why existing options are insufficient, and its trade-offs.
A request to implement a feature is not approval to add dependencies. Getting stuck is not an exception.
Installing dependencies already declared in the project is allowed when it does not change the declared dependency choices or upgrade resolved versions.
Follow the existing Socket Firewall requirement for package installation commands.`;

export default Plugin.define({
  id: "dependency-policy",
  async setup(ctx) {
    const policy = await ctx.session.hook("context", (event) => {
      if (event.system.some((part) => part.text === POLICY)) return;
      event.system.push({ type: "text", text: POLICY });
    });
    return () => policy.dispose();
  },
});
