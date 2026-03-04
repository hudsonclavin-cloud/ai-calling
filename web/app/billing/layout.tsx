import { ShellServer } from "@/components/shell-server";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ShellServer>{children}</ShellServer>;
}
