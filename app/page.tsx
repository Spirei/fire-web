import { redirect } from "next/navigation";

/** 首页直接进入后端全球预览里的投资账本。 */
export default function HomePage() {
  redirect("/global");
}
