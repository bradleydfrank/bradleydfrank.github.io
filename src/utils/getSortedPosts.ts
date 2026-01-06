import type { CollectionEntry } from "astro:content";
import postFilter from "./postFilter";

const getSortedPosts = (posts: CollectionEntry<"blog">[]) => {
  return posts
    .filter(postFilter)
    .sort(
      (a, b) => {
        const aPoster = a.data.tags?.includes("poster") ? 1 : 0;
        const bPoster = b.data.tags?.includes("poster") ? 1 : 0;
        if (aPoster !== bPoster) return bPoster - aPoster;

        return (
          Math.floor(
            new Date(b.data.modDatetime ?? b.data.pubDatetime).getTime() / 1000
          ) -
          Math.floor(
            new Date(a.data.modDatetime ?? a.data.pubDatetime).getTime() / 1000
          )
        );
      }
    );
};

export default getSortedPosts;
