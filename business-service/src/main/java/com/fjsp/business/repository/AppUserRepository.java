package com.fjsp.business.repository;

import java.util.Optional;

import com.fjsp.business.entity.AppUser;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AppUserRepository extends JpaRepository<AppUser, String> {
    Optional<AppUser> findByUsername(String username);

    boolean existsByUsername(String username);
}
