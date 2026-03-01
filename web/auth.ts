import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  callbacks: {
    async signIn({ profile }) {
      const allowed = process.env.ADMIN_GITHUB_USERNAME;
      const login = (profile as { login?: string } | null)?.login;
      if (!allowed) return false;
      return login === allowed;
    },
  },
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
