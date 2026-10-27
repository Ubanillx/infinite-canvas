declare module "ipaddr.js" {
    const ipaddr: { process(address: string): { range(): string } };
    export default ipaddr;
}
