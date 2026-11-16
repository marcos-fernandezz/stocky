import type { Metadata } from "next";
import Repositor from "@/components/Repositor";

export const metadata: Metadata = { title: "Stocky · Repositor" };

export default function Page() {
  return <Repositor />;
}
