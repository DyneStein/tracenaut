export default function handler(_req: unknown, res: any) {
  res.status(200).json({ legacy: true });
}
